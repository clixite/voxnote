/**
 * Implémentations réseau par défaut de la file d'upload (src/lib/upload/queue.ts) :
 * l'upload direct vers Vercel Blob et l'appel à `/api/transcribe`. Isolées ici
 * pour que `queue.ts` reste de la logique pure, injectable en test — voir
 * `UploadQueueOptions.uploadSegment` / `transcribeSegment`.
 *
 * Les routes serveur (`/api/blob/upload-token`, `/api/transcribe`) sont
 * développées en parallèle par `dev-backend` : ce module code contre le
 * contrat figé de `src/types/api.ts`, jamais contre une implémentation.
 */
import { upload } from "@vercel/blob/client";

import type {
  ApiErrorBody,
  TranscribeRequestBody,
  TranscribeResponseBody,
  UploadTokenPayload,
} from "@/types/api";
import type { LangSetting } from "@/types/notes";

import { ApiRequestError } from "./errors";

export interface SegmentUploadInput {
  noteId: string;
  seq: number;
  blob: Blob;
  mimeType: string;
}

/**
 * Chemin du blob, contractuel (voir api.ts) : `audio/{noteId}/{seq}` — c'est
 * ce préfixe qui permet à la suppression et au cron de purge de retrouver les
 * blobs d'une note sans base de données. Ne JAMAIS le faire dériver
 * autrement.
 */
export function blobPathnameFor(noteId: string, seq: number): string {
  return `audio/${noteId}/${seq}`;
}

/**
 * Téléverse un segment directement vers Vercel Blob via le handshake de jeton
 * de `@vercel/blob/client`. Renvoie l'URL du blob, à transmettre telle quelle
 * à `transcribeSegment` — jamais le binaire lui-même par la suite (skill
 * audio-web + api.ts : l'audio ne transite jamais par une route API).
 *
 * Le blob est privé (architecture.md : « Blob privé, non énumérable ») :
 * l'accès en lecture par le pipeline de transcription se fait côté serveur,
 * jamais par une URL publique devinable.
 */
export async function uploadSegmentBlob(input: SegmentUploadInput): Promise<string> {
  const payload: UploadTokenPayload = {
    noteId: input.noteId,
    seq: input.seq,
    mimeType: input.mimeType,
    sizeBytes: input.blob.size,
  };
  const result = await upload(blobPathnameFor(input.noteId, input.seq), input.blob, {
    access: "private",
    handleUploadUrl: "/api/blob/upload-token",
    clientPayload: JSON.stringify(payload),
  });
  return result.url;
}

export interface SegmentTranscribeInput {
  noteId: string;
  seq: number;
  blobUrl: string;
  mimeType: string;
  lang: LangSetting;
}

function looksLikeApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ApiErrorBody>;
  return (
    typeof candidate.error === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.retryable === "boolean"
  );
}

/**
 * Appelle `/api/transcribe` pour UN segment déjà présent dans Blob. Ne
 * transmet jamais de binaire (contrat api.ts) : uniquement l'URL renvoyée par
 * `uploadSegmentBlob`.
 *
 * Sur une réponse d'erreur bien formée, rejette avec `ApiRequestError` — le
 * seul cas où `classifyUploadError` (errors.ts) peut suivre `retryable` sans
 * deviner. Sur une réponse d'erreur mal formée (route pas encore déployée,
 * corps inattendu), rejette avec une erreur générique : `classifyUploadError`
 * la traite alors comme ambiguë plutôt que de supposer un sens à un champ
 * absent.
 */
export async function transcribeSegmentBlob(
  input: SegmentTranscribeInput,
): Promise<TranscribeResponseBody> {
  const body: TranscribeRequestBody = {
    noteId: input.noteId,
    seq: input.seq,
    blobUrl: input.blobUrl,
    mimeType: input.mimeType,
    lang: input.lang,
  };

  const response = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const parsed: unknown = await response.json().catch(() => undefined);
    if (looksLikeApiErrorBody(parsed)) {
      throw new ApiRequestError(parsed);
    }
    throw new Error(`/api/transcribe a répondu ${response.status} sans corps exploitable.`);
  }

  return (await response.json()) as TranscribeResponseBody;
}
