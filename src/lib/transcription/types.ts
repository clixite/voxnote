/**
 * Interface unique de transcription, conforme à `docs/PROVIDER-TRANSCRIPTION.md`.
 *
 * Trois implémentations (`groq`, `openai`, `gladia`) partagent cette forme.
 * `transcribe` prend l'URL du blob Vercel, jamais le binaire : chaque
 * implémentation télécharge elle-même l'audio via `downloadBlobAudio`
 * (`./audio-source.ts`), en s'authentifiant avec notre propre
 * `BLOB_READ_WRITE_TOKEN` — jamais en exposant l'URL privée à un tiers.
 */

import type { ProviderId } from "@/types/api";
import type { Lang } from "@/types/notes";

export interface TranscriptionResult {
  text: string;
  /** Code ISO détecté par le provider, ou la langue forcée si le provider ne la renvoie pas. */
  language: string;
  durationMs: number;
  provider: ProviderId;
}

export interface TranscribeInput {
  /** URL du blob Vercel (privé). Jamais le binaire. */
  audioUrl: string;
  mimeType: string;
  /** Absent = détection automatique par le provider. */
  language?: Lang;
  signal?: AbortSignal;
}

export interface TranscriptionProvider {
  readonly id: ProviderId;
  transcribe(input: TranscribeInput): Promise<TranscriptionResult>;
}
