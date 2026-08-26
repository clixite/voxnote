/**
 * Valide un chemin de redirection post-connexion pour empêcher une
 * redirection ouverte (open redirect).
 *
 * N'accepte qu'un chemin interne : commence par un seul `/`, jamais par
 * `//` (qu'un navigateur interprète comme une URL relative au protocole,
 * donc potentiellement externe — c'est le vecteur classique
 * `/login?from=//evil.com`) ni par `/\` (contournement équivalent connu de
 * certains navigateurs).
 *
 * AVANT ces tests de préfixe, on normalise la chaîne comme le fera le
 * navigateur : l'URL Standard (WHATWG) retire silencieusement toute
 * tabulation, retour ligne (`\n`) et retour chariot (`\r`) — où qu'ils
 * soient dans la chaîne — avant même de commencer à parser. Sans cette
 * normalisation, `/\t/evil.com` passe les trois tests de préfixe tel quel
 * (il commence bien par un seul `/`), puis redevient `//evil.com` une fois
 * parsé par `new URL(...)` — redirection ouverte. Tout autre caractère de
 * contrôle restant après cette normalisation est rejeté sans chercher à
 * deviner comment tel ou tel client le traiterait.
 *
 * Utilisée ici par le middleware quand il construit lui-même le paramètre
 * `from` (voir `src/middleware.ts`), et par l'écran de connexion
 * (`src/app/login`, hors périmètre de ce fichier) au moment de consommer
 * `from` pour la redirection post-connexion.
 */

// Tabulation, LF, CR : exactement ce que l'URL Standard retire avant parsing.
const BROWSER_STRIPPED_CHARS = /[\t\n\r]/g;

// Tout caractère de contrôle C0 ou DEL restant après ce retrait : rejeté.
const REMAINING_CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function sanitizeRedirectPath(
  candidate: string | null | undefined,
): string {
  const fallback = "/";
  if (!candidate) return fallback;

  const normalized = candidate.replace(BROWSER_STRIPPED_CHARS, "");

  if (REMAINING_CONTROL_CHARS.test(normalized)) return fallback;
  if (!normalized.startsWith("/")) return fallback;
  if (normalized.startsWith("//")) return fallback;
  if (normalized.startsWith("/\\")) return fallback;

  return normalized;
}
