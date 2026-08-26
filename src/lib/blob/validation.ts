/**
 * Validation du payload d'upload et calcul du chemin de blob.
 *
 * Le client peut mentir : `mimeType`, `sizeBytes`, `noteId` et `seq` arrivent
 * dans `clientPayload` (une chaîne JSON non typée côté serveur, cf.
 * `HandleUploadBody` de `@vercel/blob/client`). C'est cette validation, et
 * elle seule, qui décide si un jeton d'upload est émis — voir
 * `src/types/api.ts` (`UploadTokenPayload`) et le ticket P3-1.
 */
import {
  ALLOWED_AUDIO_MIME_TYPES,
  MAX_SEGMENT_BYTES,
  type UploadTokenPayload,
} from "@/types/api";

const ALLOWED_MIME_TYPES = new Set<string>(ALLOWED_AUDIO_MIME_TYPES);

// `noteId` est un `crypto.randomUUID()` généré côté client (voir
// `src/components/activeRecordingMarker.ts`). On valide la forme UUID
// générique (8-4-4-4-12 hexadécimal) sans imposer la version : coupler cette
// validation à un détail d'implémentation client (v4) est un risque inutile.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_SEQ = 100_000;

/**
 * Levée pour tout payload d'upload invalide. Le message est en français et
 * affichable tel quel à l'utilisateur (contrainte n°6 du projet) — jamais un
 * message d'erreur brut du SDK Blob.
 */
export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadValidationError";
  }
}

/**
 * Parse et valide intégralement le `clientPayload` reçu par la route
 * `POST /api/blob/upload-token`. Lève `UploadValidationError` (jamais
 * silencieux) au premier contrôle qui échoue.
 */
export function parseUploadTokenPayload(
  clientPayload: string | null,
): UploadTokenPayload {
  if (!clientPayload) {
    throw new UploadValidationError(
      "Requête d'upload invalide : informations manquantes.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(clientPayload);
  } catch {
    throw new UploadValidationError(
      "Requête d'upload invalide : informations manquantes.",
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new UploadValidationError(
      "Requête d'upload invalide : informations manquantes.",
    );
  }

  const { noteId, seq, mimeType, sizeBytes } = parsed as Record<
    string,
    unknown
  >;

  if (typeof noteId !== "string" || !UUID_PATTERN.test(noteId)) {
    throw new UploadValidationError("Identifiant de note invalide.");
  }

  if (
    typeof seq !== "number" ||
    !Number.isInteger(seq) ||
    seq < 0 ||
    seq > MAX_SEQ
  ) {
    throw new UploadValidationError("Numéro de segment invalide.");
  }

  if (typeof mimeType !== "string" || !ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new UploadValidationError(
      "Ce format audio n'est pas pris en charge.",
    );
  }

  if (
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > MAX_SEGMENT_BYTES
  ) {
    throw new UploadValidationError(
      "Ce fichier audio est trop volumineux pour un segment.",
    );
  }

  return { noteId, seq, mimeType, sizeBytes };
}

/**
 * Chemin de blob contractuel pour un segment donné. Ne JAMAIS changer ce
 * format : la suppression (`DELETE /api/notes/[noteId]`) et le cron de purge
 * retrouvent les blobs d'une note par ce préfixe, sans base de données.
 */
export function blobPathFor(noteId: string, seq: number): string {
  return `audio/${noteId}/${seq}`;
}

/** Préfixe sous lequel vivent tous les segments audio d'une note. */
export function audioPrefixForNote(noteId: string): string {
  return `audio/${noteId}/`;
}

/** Préfixe sous lequel vivent tous les segments audio, toutes notes confondues. */
export const AUDIO_PREFIX = "audio/";

/** Même contrôle de forme que `parseUploadTokenPayload`, réutilisé par `DELETE /api/notes/[noteId]`. */
export function isValidNoteId(noteId: string): boolean {
  return UUID_PATTERN.test(noteId);
}
