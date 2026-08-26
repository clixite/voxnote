/**
 * Instancie le `TranscriptionProvider` sélectionné. Chaque appel relit
 * `process.env` (via `resolveProviderId` et les providers eux-mêmes) : pas de
 * cache module-level, pour la même raison qu'`src/lib/auth/env.ts` — un
 * changement de variable d'environnement (redéploiement) doit prendre effet
 * à la requête suivante.
 */

import type { ProviderId } from "@/types/api";

import { createGladiaProvider } from "./providers/gladia";
import { createGroqProvider } from "./providers/groq";
import { createOpenAiProvider } from "./providers/openai";
import { resolveProviderId } from "./provider-id";
import type { TranscriptionProvider } from "./types";

export function getTranscriptionProvider(
  id: ProviderId = resolveProviderId(),
): TranscriptionProvider {
  switch (id) {
    case "groq":
      return createGroqProvider();
    case "openai":
      return createOpenAiProvider();
    case "gladia":
      return createGladiaProvider();
  }
}

export { resolveProviderId } from "./provider-id";
export { withRetry } from "./retry";
export { TranscriptionError } from "./errors";
export type { TranscribeInput, TranscriptionProvider, TranscriptionResult } from "./types";
