/**
 * Point d'entrée du module blob vers le SDK `@vercel/blob` : toute fonction
 * qui a besoin du SDK doit être exposée ici, avec le token injecté via
 * `getBlobConfig()` (jamais le repli implicite du SDK sur
 * `process.env.BLOB_READ_WRITE_TOKEN`, dont le message d'erreur est anglais
 * et pensé pour un développeur — voir `env.ts`). C'est ce qui permet aux
 * tests d'intégration des routes de doubler ce module avec
 * `vi.mock("@/lib/blob/store")`, sans jamais avoir besoin d'un vrai token ni
 * d'accès réseau à Vercel.
 *
 * État réel au moment d'écrire ce commentaire : `src/app/api/transcribe/route.ts`
 * et `src/lib/transcription/audio-source.ts` importent encore `head`/`get`
 * directement depuis `@vercel/blob`, sans passer par `headBlob`/
 * `getBlobStream` ci-dessous — donc sans jamais atteindre le message
 * français si `BLOB_READ_WRITE_TOKEN` manque (relevé en revue). C'est un
 * signalement à l'agent propriétaire de `src/lib/transcription/**`, hors de
 * mon périmètre (`src/lib/blob/**`, `src/app/api/blob/**`,
 * `src/app/api/cron/**`) : je ne les modifie pas moi-même. Une fois ce
 * module migré de son côté, ce paragraphe devient obsolète — le retirer.
 */
import { del, get, head, list } from "@vercel/blob";
import type {
  GetBlobResult,
  GetCommandOptions,
  HeadBlobResult,
} from "@vercel/blob";
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
 * Liste, page par page, les blobs dont le chemin commence par `prefix` (le
 * SDK pagine par lots de 1000 au plus). Un générateur plutôt qu'un tableau
 * accumulé : ça permet à l'appelant (voir `GET /api/cron/purge`) de traiter
 * — et supprimer — chaque page au fur et à mesure, sans perdre le travail
 * déjà fait si une page ultérieure échoue.
 */
export async function* listBlobPagesByPrefix(
  prefix: string,
): AsyncGenerator<BlobFile[]> {
  const { token } = getBlobConfig();
  let cursor: string | undefined;

  do {
    const page = await list({ prefix, cursor, token });
    yield page.blobs.map((blob) => ({
      url: blob.url,
      pathname: blob.pathname,
      uploadedAt: blob.uploadedAt,
    }));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
}

/**
 * Liste tous les blobs dont le chemin commence par `prefix`, toutes pages
 * accumulées. Convient à un préfixe borné (une seule note : quelques
 * segments au plus) — pour un préfixe potentiellement large (toutes les
 * notes, voir le cron de purge), préférer `listBlobPagesByPrefix` pour
 * traiter chaque page sans tout garder en mémoire ni tout perdre d'un coup
 * sur un échec tardif.
 */
export async function listBlobsByPrefix(prefix: string): Promise<BlobFile[]> {
  const files: BlobFile[] = [];
  for await (const page of listBlobPagesByPrefix(prefix)) {
    files.push(...page);
  }
  return files;
}

// Le SDK envoie tout le tableau d'URL en un seul appel HTTP à `del()`, sans
// borne connue côté service. Sur une liste large (purge de plusieurs
// milliers de blobs orphelins après un incident), un seul appel géant est un
// point de défaillance unique évitable : on le découpe en lots.
const DELETE_BATCH_SIZE = 250;

/**
 * Supprime les blobs donnés, par lots de `DELETE_BATCH_SIZE`. No-op si la
 * liste est vide (pas d'appel réseau inutile). Un lot qui échoue fait
 * rejeter la promesse — les lots précédents, eux, ont déjà été supprimés
 * pour de vrai : c'est à l'appelant de décider quoi faire de ce succès
 * partiel (voir `GET /api/cron/purge`, qui l'accepte délibérément plutôt que
 * de le masquer derrière un échec total).
 */
export async function deleteBlobs(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const { token } = getBlobConfig();

  for (let i = 0; i < urls.length; i += DELETE_BATCH_SIZE) {
    const batch = urls.slice(i, i + DELETE_BATCH_SIZE);
    await del(batch, { token });
  }
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

/**
 * Passe-plat vers `head` (métadonnées d'un blob : taille, type, date
 * d'upload...), token injecté explicitement. Exposée pour
 * `src/lib/transcription/**` (voir le signalement en tête de fichier) :
 * cette fonction n'a pas encore d'appelant dans ce module.
 */
export async function headBlob(urlOrPathname: string): Promise<HeadBlobResult> {
  const { token } = getBlobConfig();
  return head(urlOrPathname, { token });
}

/**
 * Passe-plat vers `get` (téléchargement d'un blob), token injecté
 * explicitement. `access: "private"` est fixé ici, jamais paramétrable :
 * tous les blobs audio de VoxNote sont privés (voir
 * `src/app/api/blob/upload-token/route.ts`), rien n'a de raison légitime
 * d'en lire un en mode public. Exposée pour `src/lib/transcription/**` (voir
 * le signalement en tête de fichier) : cette fonction n'a pas encore
 * d'appelant dans ce module.
 */
export async function getBlobStream(
  urlOrPathname: string,
  options?: Omit<GetCommandOptions, "access" | "token">,
): Promise<GetBlobResult | null> {
  const { token } = getBlobConfig();
  return get(urlOrPathname, { ...options, access: "private", token });
}

export type { HandleUploadBody };
