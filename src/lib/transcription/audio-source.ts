/**
 * Téléchargement de l'audio d'un segment depuis Vercel Blob, pour le compte
 * d'un provider (`transcribe({ audioUrl })` ne reçoit jamais le binaire,
 * seulement l'URL — voir `./types.ts`).
 *
 * Passe par `getBlobStream()` (`@/lib/blob/store`, revue C4) plutôt que
 * d'importer `@vercel/blob` directement : c'est la seule porte d'entrée du
 * SDK dans le projet, et c'est elle qui injecte `BLOB_READ_WRITE_TOKEN`
 * explicitement (jamais le repli implicite du SDK, dont le message d'erreur
 * anglais ne serait jamais vu par l'utilisatrice). Un `fetch` nu sur l'URL
 * échouerait de toute façon : le blob est privé (`docs/ARCHITECTURE.md`).
 *
 * Ce n'est PAS ce module qui décide si `audioUrl` appartient à notre store —
 * cette vérification (garde anti-SSRF) est faite une fois, en amont, par la
 * route (`headBlob()`, voir `src/app/api/transcribe/route.ts`) avant même
 * d'appeler un provider.
 */

import { getBlobStream } from "@/lib/blob/store";

import { translateBlobError } from "./blob-errors";
import { audioUnreadableError } from "./errors";

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
    result = await getBlobStream(audioUrl, { abortSignal: signal });
  } catch (error) {
    throw translateBlobError(error);
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
