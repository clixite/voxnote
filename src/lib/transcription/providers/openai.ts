/**
 * OpenAI. API identique à Groq pour cet usage — voir `./openai-compatible.ts`.
 *
 * Modèle : `whisper-1`, pas `gpt-4o-transcribe` / `gpt-4o-mini-transcribe`.
 * Ces deux derniers ne supportent pas `response_format: "verbose_json"`
 * (donc pas de `language` ni de `duration` dans la réponse), ce qui casserait
 * la mutualisation avec Groq dans `openai-compatible.ts` et nous priverait de
 * la langue détectée exigée par `TranscriptionResult`. `whisper-1` est aussi
 * noté comme l'API la plus mature dans le comparatif de
 * `docs/PROVIDER-TRANSCRIPTION.md`.
 */

import type { TranscriptionProvider } from "../types";
import { createOpenAiCompatibleProvider } from "./openai-compatible";

export function createOpenAiProvider(fetchImpl?: typeof fetch): TranscriptionProvider {
  return createOpenAiCompatibleProvider({
    id: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
    apiKeyEnvVar: "OPENAI_API_KEY",
    fetchImpl,
  });
}
