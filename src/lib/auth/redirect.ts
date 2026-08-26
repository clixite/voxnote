/**
 * Valide un chemin de redirection post-connexion pour empêcher une
 * redirection ouverte (open redirect).
 *
 * N'accepte qu'un chemin interne : commence par un seul `/`, jamais par
 * `//` (qu'un navigateur interprète comme une URL relative au protocole,
 * donc potentiellement externe — c'est le vecteur classique
 * `/login?from=//evil.com`) ni par `/\` (contournement équivalent connu de
 * certains navigateurs). Toute valeur qui ne respecte pas ces règles
 * retombe sur `/`.
 *
 * Utilisée ici par le middleware quand il construit lui-même le paramètre
 * `from` (voir `src/middleware.ts`), et à réutiliser par l'écran de
 * connexion (`src/app/login`, hors périmètre de ce fichier) au moment de
 * consommer `from` pour la redirection post-connexion.
 */
export function sanitizeRedirectPath(
  candidate: string | null | undefined,
): string {
  const fallback = "/";
  if (!candidate) return fallback;
  if (!candidate.startsWith("/")) return fallback;
  if (candidate.startsWith("//")) return fallback;
  if (candidate.startsWith("/\\")) return fallback;
  return candidate;
}
