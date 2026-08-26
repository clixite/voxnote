/**
 * Téléchargement de l'audio d'un segment depuis Vercel Blob, pour le compte
 * d'un provider (`transcribe({ audioUrl })` ne reçoit jamais le binaire,
 * seulement l'URL — voir `./types.ts`).
 *
 * Utilise `@vercel/blob` (déjà une dépendance du projet), authentifié par
 * `BLOB_READ_WRITE_TOKEN`, jamais un `fetch` nu sur l'URL : le blob est privé
 * (`docs/ARCHITECTURE.md`), un `fetch` nu échouerait de toute façon sans le
 * jeton, et surtout ce n'est PAS ce module qui décide si `audioUrl`
 * appartient à notre store — cette vérification (garde anti-SSRF) est faite
 * une fois, en amont, par la route (`head()`, voir
 * `src/app/api/transcribe/route.ts`) avant même d'appeler un provider.
 */

import { get } from "@vercel/blob";

import {
  audioUnreadableError,
  providerUnavailableError,
  serverMisconfiguredError,
  type TranscriptionError,
} from "./errors";

export interface DownloadedAudio {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
}

export async function downloadBlobAudio(
  audioUrl: string,
  signal?: AbortSignal,
): Promise<DownloadedAudio> {
  let result;
  try {
    result = await get(audioUrl, { access: "private", abortSignal: signal });
  } catch (error) {
    throw translateBlobDownloadError(error);
  }

  if (!result || result.statusCode !== 200 || !result.stream) {
    throw audioUnreadableError(
      `Blob introuvable ou vide pour ce segment (${audioUrl}).`,
    );
  }

  const bytes = await readStreamToBytes(result.stream);
  return { bytes, contentType: result.blob.contentType };
}

async function readStreamToBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Classe les erreurs de `@vercel/blob` par `.name` plutôt que par
 * `instanceof` : ce module n'a pas besoin d'importer chaque classe concrète
 * pour rester correct (même choix que
 * `src/lib/recorder/errors.ts#nonRetryableStoreError`).
 */
function translateBlobDownloadError(error: unknown): TranscriptionError {
  const name = (error as { name?: string } | undefined)?.name;
  const detail = `Échec du téléchargement Blob (${name ?? "erreur inconnue"}).`;

  switch (name) {
    case "BlobNotFoundError":
      return audioUnreadableError(detail);
    // Le jeton n'a plus accès à ce store : problème d'exploitation, pas de
    // fichier — ni le client ni un réessai ne peuvent y faire quoi que ce soit.
    case "BlobAccessError":
    case "BlobStoreNotFoundError":
      return serverMisconfiguredError(detail);
    // Panne ou limitation ponctuelle du service Blob lui-même : transitoire.
    case "BlobServiceRateLimited":
    case "BlobServiceNotAvailable":
      return providerUnavailableError(detail);
    default:
      // Erreur réseau ou inattendue : traitée comme transitoire par défaut,
      // plutôt que d'abandonner un segment sur un aléa ponctuel.
      return providerUnavailableError(detail);
  }
}
