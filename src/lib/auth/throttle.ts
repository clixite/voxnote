/**
 * Throttling best-effort des tentatives de connexion échouées, par IP.
 *
 * LIMITE ASSUMÉE ET DOCUMENTÉE : ce compteur vit en mémoire du process
 * serverless. Il ne survit PAS à un cold start, et n'est PAS partagé entre
 * plusieurs instances quand Vercel scale horizontalement — chaque instance a
 * son propre compteur. Ce n'est donc pas un vrai rate limiting distribué,
 * seulement un frein de bon aloi.
 *
 * Le vrai frein contre le bruteforce en ligne est ailleurs : bcrypt est lent
 * par construction (~100 ms par essai), ce qui rend l'attaque peu rentable
 * à condition que la phrase de passe soit longue (voir
 * `scripts/hash-password.mjs`, qui refuse moins de 12 caractères).
 */

const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;

// Plafond du nombre d'IP suivies simultanément. Sans lui, une IP différente
// (forgée via l'en-tête le moins fiable, voir `ip.ts`) à chaque tentative
// créerait une entrée jamais purgée puisque non expirée : croissance mémoire
// non bornée le temps d'une seule fenêtre de 5 minutes. Au-delà, on évince
// les entrées les plus anciennes plutôt que de refuser les nouvelles — le
// throttling reste best-effort, mieux vaut perdre un peu de précision que
// laisser grossir la mémoire du process indéfiniment.
export const MAX_TRACKED_IPS = 5000;

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

function isExpired(bucket: Bucket, now: number): boolean {
  return now - bucket.windowStart > WINDOW_MS;
}

/** Retire du Map toutes les entrées dont la fenêtre est passée. */
function purgeExpired(now: number): void {
  for (const [ip, bucket] of buckets) {
    if (isExpired(bucket, now)) buckets.delete(ip);
  }
}

/**
 * Si le nombre d'IP suivies dépasse la limite, évince les plus anciennes.
 * Un `Map` JS conserve l'ordre d'insertion : les premières entrées itérées
 * sont donc les plus anciennes (`recordFailedAttempt` recrée l'entrée,
 * donc la remet en fin d'ordre, à chaque nouvelle fenêtre pour cette IP).
 */
function enforceCapacity(): void {
  if (buckets.size <= MAX_TRACKED_IPS) return;
  const excess = buckets.size - MAX_TRACKED_IPS;
  let removed = 0;
  for (const ip of buckets.keys()) {
    if (removed >= excess) break;
    buckets.delete(ip);
    removed += 1;
  }
}

/** `true` si l'IP a atteint la limite de tentatives échouées sur la fenêtre en cours. */
export function isThrottled(ip: string): boolean {
  const bucket = buckets.get(ip);
  if (!bucket) return false;
  if (isExpired(bucket, Date.now())) {
    buckets.delete(ip);
    return false;
  }
  return bucket.count >= MAX_ATTEMPTS;
}

/** Enregistre une tentative échouée pour cette IP. */
export function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  purgeExpired(now);

  const bucket = buckets.get(ip);
  if (!bucket || isExpired(bucket, now)) {
    buckets.set(ip, { count: 1, windowStart: now });
  } else {
    bucket.count += 1;
  }

  enforceCapacity();
}

/** Réinitialise le compteur d'une IP (appelé après une connexion réussie). */
export function resetAttempts(ip: string): void {
  buckets.delete(ip);
}

/** Réservé aux tests : vide l'état global entre les cas de test. */
export function resetThrottleStateForTests(): void {
  buckets.clear();
}

/** Réservé aux tests : nombre d'IP actuellement suivies. */
export function getTrackedIpCountForTests(): number {
  return buckets.size;
}
