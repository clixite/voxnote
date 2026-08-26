/**
 * Sélection du provider par `TRANSCRIBE_PROVIDER`, validée À L'USAGE — jamais
 * à l'import du module, jamais au chargement de la route. `pnpm build`
 * tourne en CI sans les vraies variables d'environnement ; si cette
 * validation s'exécutait au chargement du module, un import incident pendant
 * l'analyse statique de Next.js ferait échouer le build alors qu'aucune
 * requête n'a encore eu lieu (même raisonnement que `src/lib/auth/env.ts`).
 *
 * Absente ou vide → défaut documenté (`groq`, voir `.env.example` et
 * `docs/PROVIDER-TRANSCRIPTION.md`). Valeur présente mais inconnue → échec
 * explicite listant les valeurs valides : jamais un repli silencieux sur le
 * défaut, qui enverrait l'audio vers un fournisseur différent de celui que
 * l'exploitant croit avoir configuré.
 */

import type { ProviderId } from "@/types/api";

import { serverMisconfiguredError } from "./errors";

const VALID_PROVIDER_IDS: readonly ProviderId[] = ["groq", "openai", "gladia"];
const DEFAULT_PROVIDER_ID: ProviderId = "groq";

function isValidProviderId(value: string): value is ProviderId {
  return (VALID_PROVIDER_IDS as readonly string[]).includes(value);
}

export function resolveProviderId(): ProviderId {
  const raw = process.env.TRANSCRIBE_PROVIDER;

  if (raw === undefined || raw === "") {
    return DEFAULT_PROVIDER_ID;
  }

  if (isValidProviderId(raw)) {
    return raw;
  }

  throw serverMisconfiguredError(
    `TRANSCRIBE_PROVIDER="${raw}" n'est pas une valeur valide. ` +
      `Valeurs acceptées : ${VALID_PROVIDER_IDS.join(", ")}. Corrige la ` +
      "variable d'environnement Vercel avant de redéployer.",
  );
}
