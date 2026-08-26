/**
 * Extrait une IP "best-effort" pour le throttling, à partir des en-têtes
 * posés par la plateforme.
 *
 * Ordre de priorité, du plus fiable au moins fiable :
 *  1. `x-vercel-forwarded-for` : posée par le edge network de Vercel
 *     lui-même, jamais par le client — c'est la seule des trois qu'un
 *     visiteur ne peut pas falsifier en la fournissant directement.
 *  2. `x-real-ip` : généralement posée par un proxy de confiance (ou par
 *     Vercel), mais moins systématique.
 *  3. `x-forwarded-for`, en dernier recours seulement : un client qui ne
 *     passe PAS par la plateforme (dev local, tests, ou tout simplement un
 *     script) peut écrire cet en-tête lui-même. Le prendre en priorité
 *     revenait à laisser un attaquant choisir sa propre clé de throttling —
 *     un en-tête différent à chaque tentative contournait la limite.
 *
 * Aucune de ces trois n'offre de garantie cryptographique d'authenticité :
 * c'est pourquoi le throttling reste documenté comme best-effort (voir
 * `throttle.ts`), pas comme un vrai rate limiting de sécurité.
 */
export function getClientIp(request: Request): string {
  const vercelForwardedFor = request.headers.get("x-vercel-forwarded-for");
  if (vercelForwardedFor) {
    const first = vercelForwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  return "unknown";
}
