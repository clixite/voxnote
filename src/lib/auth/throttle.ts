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

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

function isExpired(bucket: Bucket, now: number): boolean {
  return now - bucket.windowStart > WINDOW_MS;
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
  const bucket = buckets.get(ip);
  if (!bucket || isExpired(bucket, now)) {
    buckets.set(ip, { count: 1, windowStart: now });
    return;
  }
  bucket.count += 1;
}

/** Réinitialise le compteur d'une IP (appelé après une connexion réussie). */
export function resetAttempts(ip: string): void {
  buckets.delete(ip);
}

/** Réservé aux tests : vide l'état global entre les cas de test. */
export function resetThrottleStateForTests(): void {
  buckets.clear();
}
