/**
 * Configuration d'authentification : lecture et VALIDATION des variables
 * d'environnement obligatoires.
 *
 * Important : cette validation se déclenche à l'USAGE (premier appel de
 * `getAuthConfig`, donc à la première requête qui touche l'auth), jamais à
 * l'import du module ni pendant `next build`. La CI construit avec des
 * valeurs factices ; si on validait au chargement du module, un import
 * incident pendant le build (analyse statique de Next.js) ferait échouer
 * `pnpm build` même sans qu'aucune requête n'ait eu lieu.
 *
 * Aucune valeur par défaut, jamais : un secret par défaut committé
 * permettrait de forger un cookie de session valide et rendrait le mot de
 * passe décoratif.
 */

const MIN_AUTH_SECRET_LENGTH = 32;

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

export interface AuthConfig {
  authSecret: string;
  appPasswordHash: string;
}

/**
 * Lit et valide `AUTH_SECRET` et `APP_PASSWORD_HASH`.
 *
 * Volontairement SANS cache : la fonction relit `process.env` à chaque
 * appel. Le coût est négligeable, et cela permet à un changement de
 * `APP_PASSWORD_HASH` (redéploiement) de prendre effet à la requête
 * suivante sans dépendre d'un état d'instance à invalider.
 */
export function getAuthConfig(): AuthConfig {
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret || authSecret.length < MIN_AUTH_SECRET_LENGTH) {
    throw new AuthConfigError(
      `AUTH_SECRET est manquant ou trop court (${MIN_AUTH_SECRET_LENGTH} caractères minimum). ` +
        "Générez une valeur aléatoire (ex. `openssl rand -base64 32`) et configurez-la dans les variables d'environnement Vercel avant de redéployer.",
    );
  }

  const appPasswordHash = process.env.APP_PASSWORD_HASH;
  if (!appPasswordHash) {
    throw new AuthConfigError(
      "APP_PASSWORD_HASH est manquant. Générez-le avec `pnpm hash-password` et configurez-le dans les variables d'environnement Vercel avant de redéployer.",
    );
  }

  return { authSecret, appPasswordHash };
}
