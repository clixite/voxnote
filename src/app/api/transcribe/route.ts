/**
 * `POST /api/transcribe` — transcrit UN segment déjà présent dans Vercel
 * Blob, et répond avec le texte. Voir `src/types/api.ts` (contrat figé) pour
 * la raison d'être synchrone, sans jobId ni polling : sans base de données,
 * le client (IndexedDB) est seul à savoir quels segments restent à traiter.
 *
 * Protégée par le middleware global (`src/middleware.ts`) : cette route n'est
 * pas dans la liste des chemins exclus, donc aucune requête n'y arrive sans
 * session valide — pas de second contrôle de session ici.
 */

import { NextResponse } from "next/server";

import { getClientIp } from "@/lib/auth/ip";
import { headBlob } from "@/lib/blob/store";
import { isValidNoteId } from "@/lib/blob/validation";
import { translateBlobError } from "@/lib/transcription/blob-errors";
import { isRateLimited } from "@/lib/transcription/rate-limit";
import { getTranscriptionProvider } from "@/lib/transcription/registry";
import { resolveProviderId } from "@/lib/transcription/provider-id";
import { TranscriptionError } from "@/lib/transcription/errors";
import { withRetry } from "@/lib/transcription/retry";
import {
  ALLOWED_AUDIO_MIME_TYPES,
  type ApiErrorBody,
  type ApiErrorCode,
  type TranscribeRequestBody,
  type TranscribeResponseBody,
} from "@/types/api";
import type { LangSetting } from "@/types/notes";

// `@/lib/blob/store` (`headBlob`, et `getBlobStream` utilisé par les
// providers via `downloadBlobAudio`) s'appuie sur `@vercel/blob`/`undici` :
// runtime Node explicite, pas edge.
export const runtime = "nodejs";

// Groq répond en quelques secondes ; Gladia (upload + job + polling borné,
// voir `src/lib/transcription/providers/gladia.ts`) peut prendre jusqu'à
// ~90 s pour un segment de ~5 min dans le pire cas. 120 s laisse de la marge
// aux trois providers, y compris un réessai après une erreur transitoire.
// Nécessite un plan Vercel dont la limite de durée de fonction dépasse 60 s
// (Hobby plafonne à 60 s) si le provider de production est `gladia`.
export const maxDuration = 120;

const MAX_BODY_BYTES = 8 * 1024; // Un JSON de quelques champs tient sur quelques centaines d'octets.

const VALID_LANG_SETTINGS: readonly LangSetting[] = ["auto", "fr", "nl", "en"];

const STATUS_BY_TRANSCRIPTION_CODE: Record<
  Extract<
    ApiErrorCode,
    "AUDIO_UNREADABLE" | "PROVIDER_QUOTA" | "PROVIDER_UNAVAILABLE" | "SERVER_MISCONFIGURED"
  >,
  number
> = {
  AUDIO_UNREADABLE: 422,
  PROVIDER_QUOTA: 429,
  PROVIDER_UNAVAILABLE: 503,
  SERVER_MISCONFIGURED: 500,
};

function errorResponse(
  error: ApiErrorCode,
  message: string,
  retryable: boolean,
  status: number,
): NextResponse {
  const body: ApiErrorBody = { error, message, retryable };
  return NextResponse.json(body, { status });
}

function badRequest(): NextResponse {
  return errorResponse(
    "BAD_REQUEST",
    "Requête invalide.",
    false,
    400,
  );
}

function payloadTooLarge(): NextResponse {
  return errorResponse(
    "PAYLOAD_TOO_LARGE",
    "Cette requête est trop volumineuse. Le fichier audio ne doit jamais être envoyé à cette route : seule l'URL du blob est attendue.",
    false,
    413,
  );
}

function rateLimited(): NextResponse {
  return errorResponse(
    "RATE_LIMITED",
    "Trop de demandes de transcription en peu de temps. Réessaie dans quelques minutes.",
    true,
    429,
  );
}

function invalidBlobUrl(): NextResponse {
  return errorResponse(
    "BAD_REQUEST",
    "Ce lien audio n'est pas valide pour cette note.",
    false,
    400,
  );
}

/**
 * Lit le corps en le bornant en octets pendant la lecture du flux — pas
 * seulement via l'en-tête `Content-Length`, falsifiable ou absent (encodage
 * `chunked`). C'est le verrou explicite contre le piège classique de ce type
 * de route : lui envoyer le binaire audio directement plutôt que l'URL du
 * blob (voir `src/types/api.ts`, section upload).
 */
async function readBoundedBody(
  request: Request,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const declared = Number(declaredLength);
    if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) {
      return { ok: false };
    }
  }

  if (!request.body) {
    return { ok: true, text: "" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(value);
    }
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

/**
 * Forme UUID réutilisée depuis `@/lib/blob/validation` : même contrat que
 * `/api/blob/upload-token`, pas de validation dupliquée et divergente entre
 * les deux routes (revue S4, 2026-08-26). `isValidNoteId` du module importé
 * prend un `string`, pas un `unknown` : ce wrapper ajoute juste le contrôle
 * de type nécessaire pour un champ JSON non typé.
 */
function isValidNoteIdValue(value: unknown): value is string {
  return typeof value === "string" && isValidNoteId(value);
}

function isValidSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isValidMimeType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (ALLOWED_AUDIO_MIME_TYPES as readonly string[]).includes(value)
  );
}

function isValidLang(value: unknown): value is LangSetting {
  return typeof value === "string" && VALID_LANG_SETTINGS.includes(value as LangSetting);
}

function isValidBlobUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function parseRequestBody(raw: unknown): TranscribeRequestBody | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { noteId, seq, blobUrl, mimeType, lang } = raw as Record<string, unknown>;
  if (
    !isValidNoteIdValue(noteId) ||
    !isValidSeq(seq) ||
    !isValidBlobUrl(blobUrl) ||
    !isValidMimeType(mimeType) ||
    !isValidLang(lang)
  ) {
    return undefined;
  }
  return { noteId, seq, blobUrl, mimeType, lang };
}

type BlobOwnershipCheck =
  | { status: "owned" }
  /** `blobUrl` n'est vraiment pas le bon segment : réponse 400 non réessayable. */
  | { status: "invalid" }
  /** Panne d'infra Blob ou mauvaise configuration : jamais un verdict sur la donnée. */
  | { status: "error"; error: TranscriptionError };

/**
 * Garde anti-SSRF : vérifie que `blobUrl` appartient bien à NOTRE store
 * Blob avant tout téléchargement, ET qu'il correspond exactement au segment
 * annoncé (`noteId`/`seq`) — pas seulement à un blob quelconque de notre
 * store. Sans ce second contrôle, une URL de blob volée (une autre note, un
 * autre segment) serait acceptée tant qu'elle nous appartient.
 *
 * Passe par `headBlob()` (`@/lib/blob/store`, revue C4 : le jeton
 * `BLOB_READ_WRITE_TOKEN` y est injecté explicitement, jamais le repli
 * implicite du SDK) plutôt que d'importer `@vercel/blob` directement — c'est
 * la seule porte d'entrée du SDK dans le projet. `headBlob` interroge l'API
 * de gestion Vercel Blob avec notre jeton ; elle ne fait JAMAIS de requête
 * vers `blobUrl` directement (voir `src/lib/transcription/audio-source.ts`),
 * donc rien ici ne peut servir à sonder une adresse arbitraire au nom du
 * serveur.
 *
 * Revue BLOQUANTE B3 (2026-08-26) : un `catch` nu qui traite toute erreur
 * `headBlob()` comme « blob invalide » condamnerait définitivement un
 * segment déjà uploadé à la moindre panne passagère du service Blob (le
 * client classerait la réponse 400 comme non réessayable). Seul un vrai
 * `BlobNotFoundError` — le blob n'est vraiment pas le nôtre — justifie ce
 * verdict ; toute autre erreur (réseau, panne, jeton absent) doit rester
 * réessayable ou signaler une mauvaise configuration, jamais un mensonge sur
 * la donnée elle-même.
 */
async function checkBlobOwnership(
  blobUrl: string,
  noteId: string,
  seq: number,
): Promise<BlobOwnershipCheck> {
  let meta;
  try {
    meta = await headBlob(blobUrl);
  } catch (error) {
    const translated = translateBlobError(error);
    if (translated.code === "AUDIO_UNREADABLE") {
      // Vraiment introuvable dans notre store : c'est un lien invalide, pas
      // une panne. On garde le message existant (§ `invalidBlobUrl`), pas le
      // libellé générique "audio illisible" pensé pour une transcription.
      return { status: "invalid" };
    }
    return { status: "error", error: translated };
  }

  if (meta.pathname !== `audio/${noteId}/${seq}`) {
    return { status: "invalid" };
  }
  return { status: "owned" };
}

function transcriptionErrorResponse(
  error: unknown,
  context: { noteId: string; seq: number },
): NextResponse {
  if (error instanceof TranscriptionError) {
    if (error.detail) {
      console.error(
        `[transcribe] note=${context.noteId} seq=${context.seq} ${error.code}: ${error.detail}`,
      );
    }
    return errorResponse(
      error.code,
      error.message,
      error.retryable,
      STATUS_BY_TRANSCRIPTION_CODE[error.code],
    );
  }

  console.error(
    `[transcribe] note=${context.noteId} seq=${context.seq} erreur inattendue :`,
    error,
  );
  return errorResponse(
    "SERVER_MISCONFIGURED",
    "Configuration du serveur invalide. Contacte l'administrateur.",
    false,
    500,
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const bodyResult = await readBoundedBody(request);
  if (!bodyResult.ok) {
    return payloadTooLarge();
  }

  let rawBody: unknown;
  try {
    rawBody = bodyResult.text ? JSON.parse(bodyResult.text) : undefined;
  } catch {
    return badRequest();
  }

  const parsedBody = parseRequestBody(rawBody);
  if (!parsedBody) {
    return badRequest();
  }
  const { noteId, seq, blobUrl, mimeType, lang } = parsedBody;

  const ip = getClientIp(request);
  if (isRateLimited(ip)) {
    return rateLimited();
  }

  const ownership = await checkBlobOwnership(blobUrl, noteId, seq);
  if (ownership.status === "invalid") {
    return invalidBlobUrl();
  }
  if (ownership.status === "error") {
    return transcriptionErrorResponse(ownership.error, { noteId, seq });
  }

  let providerId;
  try {
    providerId = resolveProviderId();
  } catch (error) {
    return transcriptionErrorResponse(error, { noteId, seq });
  }
  const provider = getTranscriptionProvider(providerId);

  try {
    const result = await withRetry(() =>
      provider.transcribe({
        audioUrl: blobUrl,
        mimeType,
        language: lang === "auto" ? undefined : lang,
      }),
    );

    const responseBody: TranscribeResponseBody = {
      noteId,
      seq,
      text: result.text,
      language: result.language,
      provider: result.provider,
      durationMs: result.durationMs,
    };
    return NextResponse.json(responseBody, { status: 200 });
  } catch (error) {
    return transcriptionErrorResponse(error, { noteId, seq });
  }
}
