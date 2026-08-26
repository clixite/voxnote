/**
 * Backoff exponentiel plafonné pour la file d'upload (src/lib/upload/queue.ts).
 * Logique pure, sans dépendance au temps réel : `attempt` est fourni par
 * l'appelant, jamais lu d'une horloge interne, pour rester testable avec
 * `vi.useFakeTimers()` comme `src/lib/recorder/engine.ts`.
 */

/** Délai de base avant le premier réessai. */
export const DEFAULT_BASE_DELAY_MS = 2000;

/**
 * Plafond du délai entre deux tentatives. Choisi pour qu'une coupure réseau
 * de plusieurs heures ne fasse jamais attendre plus d'une minute avant le
 * prochain essai — la reprise automatique doit rester perçue comme rapide
 * dès que la connexion revient, sans dépendre uniquement de l'écouteur
 * `online` (voir useUploadQueue.ts) qui, lui, réveille la file immédiatement.
 */
export const DEFAULT_MAX_DELAY_MS = 60_000;

export interface BackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Délai avant la tentative numéro `attempt` (1 = premier réessai après le
 * tout premier échec). `attempt <= 0` n'a pas de sens ici : renvoie 0 (essai
 * immédiat), utilisé pour la toute première tentative d'un segment neuf.
 */
export function computeBackoffDelayMs(
  attempt: number,
  options: BackoffOptions = {},
): number {
  if (attempt <= 0) return 0;
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const raw = base * 2 ** (attempt - 1);
  return Math.min(raw, max);
}
