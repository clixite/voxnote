/**
 * Rate limiting best-effort de `POST /api/transcribe`, par IP — même
 * mécanisme et mêmes limites assumées que `src/lib/auth/throttle.ts` (en
 * mémoire du process serverless : ne survit pas à un cold start, pas partagé
 * entre instances). Le but n'est pas une garantie dure, mais d'empêcher
 * qu'un script maladroit ou un bug de la queue d'upload ne vide le quota du
 * provider de transcription en boucle.
 *
 * Fenêtre et plafond dimensionnés pour absorber le pire cas légitime : une
 * note de 2 h (`NOTE_MAX_DURATION_MS`) découpée en segments de ~5 min compte
 * au plus 24 segments ; après une coupure réseau prolongée, la queue du
 * client peut les rejouer tous d'un coup à la reconnexion. 40 requêtes par
 * fenêtre de 5 minutes laisse une marge confortable au-dessus de ce pire cas
 * sans ouvrir la porte à un abus soutenu.
 */

const WINDOW_MS = 5 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 40;

// Même bornage que `throttle.ts`, même raison : sans plafond, une IP
// différente à chaque requête (en-tête falsifiable, voir `ip.ts`) créerait
// une entrée par requête, jamais purgée avant la fin de sa propre fenêtre.
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

/**
 * Enregistre une requête pour cette IP et renvoie `true` si la limite de la
 * fenêtre en cours est dépassée (requête à refuser en 429).
 */
export function isRateLimited(ip: string): boolean {
  const now = Date.now();
  purgeExpired(now);

  const bucket = buckets.get(ip);
  if (!bucket || isExpired(bucket, now)) {
    buckets.set(ip, { count: 1, windowStart: now });
    enforceCapacity();
    return false;
  }

  bucket.count += 1;
  const limited = bucket.count > MAX_REQUESTS_PER_WINDOW;
  enforceCapacity();
  return limited;
}

/** Réservé aux tests : vide l'état global entre les cas de test. */
export function resetRateLimitStateForTests(): void {
  buckets.clear();
}

/** Réservé aux tests : nombre d'IP actuellement suivies. */
export function getTrackedIpCountForTests(): number {
  return buckets.size;
}
