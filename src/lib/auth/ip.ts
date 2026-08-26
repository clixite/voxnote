/**
 * Extrait une IP "best-effort" pour le throttling, à partir des en-têtes
 * posés par la plateforme (Vercel renseigne `x-forwarded-for`). Il n'y a
 * aucune garantie d'authenticité de ces en-têtes hors de la plateforme
 * (un client peut les usurper en local) — sans conséquence ici puisque le
 * throttling est déjà documenté comme best-effort.
 */
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  return "unknown";
}
