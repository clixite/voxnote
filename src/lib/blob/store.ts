/**
 * Seule porte d'entrée vers le SDK `@vercel/blob` dans tout le projet.
 * Aucun autre fichier n'importe `@vercel/blob` ou `@vercel/blob/client`
 * directement : ça isole les appels réseau réels (impossibles à exécuter
 * dans cet environnement, sans token ni accès à Vercel) derrière des
 * fonctions que les tests d'intégration des routes peuvent doubler avec
 * `vi.mock("@/lib/blob/store")`.
 *
 * Le token est toujours passé explicitement (jamais le repli implicite du
 * SDK sur `process.env.BLOB_READ_WRITE_TOKEN`) : c'est `getBlobConfig` qui
 * valide sa présence avec un message français, avant tout appel réseau.
 */
import { del, list } from "@vercel/blob";
import {
  handleUpload,
  type HandleUploadBody,
  type HandleUploadOptions,
} from "@vercel/blob/client";

import { getBlobConfig } from "./env";

export interface BlobFile {
  url: string;
  pathname: string;
  uploadedAt: Date;
}

/**
 * Liste tous les blobs dont le chemin commence par `prefix`, toutes pages
 * confondues (le SDK pagine par lots de 1000 au plus).
 */
export async function listBlobsByPrefix(prefix: string): Promise<BlobFile[]> {
  const { token } = getBlobConfig();
  const files: BlobFile[] = [];
  let cursor: string | undefined;

  do {
    const page = await list({ prefix, cursor, token });
    for (const blob of page.blobs) {
      files.push({
        url: blob.url,
        pathname: blob.pathname,
        uploadedAt: blob.uploadedAt,
      });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return files;
}

/** Supprime les blobs donnés. No-op si la liste est vide (pas d'appel réseau inutile). */
export async function deleteBlobs(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const { token } = getBlobConfig();
  await del(urls, { token });
}

/**
 * Passe-plat vers `handleUpload` (génération de jeton d'upload client), avec
 * le token injecté explicitement. C'est la route `upload-token` qui porte
 * toute la logique métier (`onBeforeGenerateToken`) ; cette fonction ne fait
 * que garantir qu'on ne dépend jamais du repli implicite du SDK sur le token.
 */
export async function generateUploadToken(
  options: Omit<HandleUploadOptions, "token">,
): ReturnType<typeof handleUpload> {
  // `async` délibéré (plutôt que renvoyer directement la promesse de
  // `handleUpload`) : ça garantit qu'un `BlobConfigError` levé par
  // `getBlobConfig` devient toujours un rejet de promesse, jamais une
  // exception synchrone — la route appelante peut alors traiter toutes les
  // erreurs de cette fonction de la même façon, avec un seul `try/await`.
  const { token } = getBlobConfig();
  return handleUpload({ ...options, token });
}

export type { HandleUploadBody };
