/**
 * Groq — provider par défaut (voir `docs/PROVIDER-TRANSCRIPTION.md`).
 * API compatible OpenAI : ce module ne fait que fixer l'URL de base, le
 * modèle et la clé d'environnement, voir `./openai-compatible.ts`.
 */

import type { TranscriptionProvider } from "../types";
import { createOpenAiCompatibleProvider } from "./openai-compatible";

export function createGroqProvider(fetchImpl?: typeof fetch): TranscriptionProvider {
  return createOpenAiCompatibleProvider({
    id: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3-turbo",
    apiKeyEnvVar: "GROQ_API_KEY",
    fetchImpl,
  });
}
