/**
 * Configuration Vercel Blob : lecture et VALIDATION de `BLOB_READ_WRITE_TOKEN`.
 *
 * Même discipline que `src/lib/auth/env.ts` : la validation se déclenche à
 * l'USAGE (premier appel de `getBlobConfig`, donc à la première requête qui
 * touche un blob), jamais à l'import du module ni pendant `next build`. La CI
 * construit sans les vraies variables ; valider au chargement du module ferait
 * échouer `pnpm build` sans qu'aucune requête n'ait eu lieu.
 *
 * Le SDK `@vercel/blob` sait déjà retomber sur `process.env.BLOB_READ_WRITE_TOKEN`
 * si on ne lui passe pas de `token` explicite, mais son message d'erreur en ce
 * cas est en anglais et pensé pour un développeur, pas pour l'utilisatrice
 * finale de VoxNote (contrainte n°6 du projet : messages compréhensibles par
 * un non-technicien). On valide donc nous-mêmes AVANT tout appel au SDK, et on
 * lui passe le token explicitement (voir `store.ts`) pour ne jamais dépendre
 * de son repli implicite.
 */

export class BlobConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobConfigError";
  }
}

export interface BlobConfig {
  token: string;
}

/**
 * Lit et valide `BLOB_READ_WRITE_TOKEN`.
 *
 * Volontairement SANS cache, pour les mêmes raisons que `getAuthConfig` :
 * le coût est négligeable, et un token changé (rotation, redéploiement) doit
 * prendre effet à la requête suivante.
 */
export function getBlobConfig(): BlobConfig {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new BlobConfigError(
      "Le stockage audio n'est pas configuré (BLOB_READ_WRITE_TOKEN manquant). " +
        "Configure cette variable dans les variables d'environnement Vercel (Storage → Blob → Token de lecture/écriture) avant de redéployer.",
    );
  }
  return { token };
}
