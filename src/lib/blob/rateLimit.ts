/**
 * Rate limiting best-effort par IP pour `POST /api/blob/upload-token`.
 *
 * Même limite assumée que `src/lib/auth/throttle.ts` : un compteur en
 * mémoire du process serverless, qui ne survit pas à un cold start et n'est
 * pas partagé entre plusieurs instances. Ce n'est pas un vrai rate limiting
 * distribué, seulement un frein de bon aloi.
 *
 * Différence délibérée avec le throttle de connexion : celui-ci ne compte
 * QUE les tentatives échouées (il punit le bruteforce), alors qu'ici on
 * compte TOUTE requête, valide ou non — le but n'est pas de punir un mot de
 * passe faux mais de protéger le quota du fournisseur de transcription en
 * aval contre un script qui boucle sur cette route (chaque jeton émis permet
 * un upload, donc potentiellement une transcription facturée).
 *
 * Fenêtre et plafond choisis largement au-dessus d'un usage normal : un
 * enregistrement produit un segment toutes les ~5 minutes (voir
 * `RECORDER_SEGMENT_MS`), et la queue d'upload peut en redemander plusieurs
 * d'affilée après une coupure réseau (retries, segments accumulés). Rien à
 * voir avec le rythme d'un abus.
 */

const WINDOW_MS = 5 * 60 * 1000;
const MAX_REQUESTS = 60;

// Même garde-fou mémoire que `throttle.ts` : borne le nombre d'IP suivies
// simultanément pour ne pas laisser grossir la mémoire du process sans fin
// face à des en-têtes IP forgés différents à chaque requête.
export const MAX_TRACKED_IPS = 5000;

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

function isExpired(bucket: Bucket, now: number): boolean {
  return now - bucket.windowStart > WINDOW_MS;
}

function purgeExpired(now: number): void {
  for (const [ip, bucket] of buckets) {
    if (isExpired(bucket, now)) buckets.delete(ip);
  }
}

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

/** `true` si l'IP a atteint le plafond de requêtes sur la fenêtre en cours. */
export function isRateLimited(ip: string): boolean {
  const bucket = buckets.get(ip);
  if (!bucket) return false;
  if (isExpired(bucket, Date.now())) {
    buckets.delete(ip);
    return false;
  }
  return bucket.count >= MAX_REQUESTS;
}

/** Enregistre une requête pour cette IP (appelée pour chaque appel, réussi ou non). */
export function recordRequest(ip: string): void {
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

/** Réservé aux tests : vide l'état global entre les cas de test. */
export function resetRateLimitStateForTests(): void {
  buckets.clear();
}

/** Réservé aux tests : nombre d'IP actuellement suivies. */
export function getTrackedIpCountForTests(): number {
  return buckets.size;
}
