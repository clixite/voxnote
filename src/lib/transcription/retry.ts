/**
 * Retry exponentiel générique, appliqué par la route à l'appel d'un
 * `TranscriptionProvider` — jamais à l'intérieur d'un provider : la politique
 * de réessai est la même pour les trois, factoriser ailleurs l'aurait
 * dupliquée trois fois pour rien.
 *
 * Ne réessaie QUE ce qui est réellement transitoire : une erreur qui n'est
 * pas une `TranscriptionError`, ou dont `retryable` vaut `false`, est
 * relancée immédiatement, sans consommer de tentative supplémentaire.
 * Réessayer une clé API invalide ou un fichier illisible ne fait que perdre
 * du temps et, chez certains providers, brûler du quota pour rien.
 */

import { TranscriptionError } from "./errors";

export interface RetryOptions {
  /** Nombre total de tentatives (pas de réessais). Défaut : 3. */
  attempts?: number;
  /** Délai de base en ms avant le 2e essai ; doublé à chaque essai suivant. */
  baseDelayMs?: number;
  /** Appelé avant chaque attente, utile pour les tests et l'observabilité. */
  onRetry?: (error: TranscriptionError, attempt: number, delayMs: number) => void;
  /** Injectable pour les tests : évite d'attendre pour de vrai. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 300;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const retryable = error instanceof TranscriptionError && error.retryable;
      const isLastAttempt = attempt === attempts;
      if (!retryable || isLastAttempt) {
        throw error;
      }
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
  // Inatteignable (la boucle renvoie ou relance toujours), mais TypeScript
  // ne peut pas le déduire du `for` ci-dessus.
  throw new Error("withRetry: état inatteignable");
}
