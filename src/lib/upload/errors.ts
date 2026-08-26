/**
 * Classification des échecs de la file d'upload (src/lib/upload/queue.ts) en
 * trois catégories, jamais devinées à la légère (CLAUDE.md, ticket P3-4,
 * règle n°3) :
 *
 * - "retryable"     : le serveur l'a dit explicitement (`ApiErrorBody.retryable
 *                     === true`), ou c'est une coupure réseau reconnaissable
 *                     à coup sûr. Réessayé indéfiniment avec un backoff
 *                     plafonné (voir backoff.ts) : une coupure peut durer des
 *                     heures, on ne doit jamais abandonner tout seul.
 * - "non-retryable" : le serveur l'a dit explicitement (`retryable === false`).
 *                     Arrêt immédiat, aucune tentative consommée en plus :
 *                     rejouer ne changera jamais l'issue.
 * - "ambiguous"      : ni l'un ni l'autre — voir le commentaire de
 *                     `classifyUploadError` ci-dessous pour la raison précise
 *                     (lacune du contrat entre `@vercel/blob/client` et notre
 *                     route de jeton). Réessayé comme "retryable", mais avec
 *                     un nombre de tentatives plafonné (voir queue.ts) : on ne
 *                     laisse jamais une boucle silencieuse tourner pour
 *                     toujours sur une cause qu'on ne comprend pas.
 */
import type { ApiErrorBody } from "@/types/api";

/**
 * Erreur levée par le transport de transcription (transport.ts) quand
 * `/api/transcribe` répond avec un statut d'erreur : porte tel quel le corps
 * `ApiErrorBody` renvoyé par le serveur, la seule source fiable de
 * `retryable` pour cet appel. Le message est déjà en français et affichable
 * tel quel (contrat `ApiErrorBody.message`).
 */
export class ApiRequestError extends Error {
  readonly code: ApiErrorBody["error"];
  readonly retryable: boolean;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiRequestError";
    this.code = body.error;
    this.retryable = body.retryable;
  }
}

export type RetryTier = "retryable" | "non-retryable" | "ambiguous";

export interface ClassifiedUploadError {
  tier: RetryTier;
  /** Message français, prêt à afficher tel quel à l'utilisateur. */
  message: string;
}

const NETWORK_MESSAGE =
  "Impossible de contacter le serveur pour l'instant. VoxNote réessaiera tout seul dès que la connexion reviendra ; ce passage reste en sécurité sur cet appareil.";

const UNKNOWN_MESSAGE =
  "Une erreur inattendue a empêché l'envoi de ce passage. Nouvelle tentative en cours ; ce passage reste en sécurité sur cet appareil.";

const EXHAUSTED_MESSAGE =
  "L'envoi de ce passage échoue depuis plusieurs tentatives, pour une raison inconnue. Ce passage reste en sécurité sur cet appareil : appuie sur Réessayer quand tu veux relancer l'envoi.";

/**
 * `fetch()` rejette avec un `TypeError` générique quand la requête n'a même
 * pas pu partir : "Failed to fetch" (Chrome/Firefox), "Load failed" (Safari),
 * "NetworkError when attempting to fetch resource" (Firefox). Un seul point
 * commun fiable entre navigateurs : le type de l'exception, jamais le texte
 * du message (qui varie et n'est pas contractuel).
 */
function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError;
}

/**
 * Classe un échec de la file en l'une des trois catégories ci-dessus.
 *
 * Lacune du contrat rencontrée pendant l'implémentation (voir le rapport de
 * ticket) : `upload()` de `@vercel/blob/client` appelle notre route
 * `/api/blob/upload-token` en interne pour obtenir un jeton, et AVALE le
 * corps de sa réponse en cas d'échec — elle rejette avec un `BlobError`
 * générique ("Failed to retrieve the client token"), quel que soit le code
 * HTTP ou le contenu de notre `ApiErrorBody` (401, 400, 429...). `retryable`
 * n'est donc jamais consultable pour un échec survenant à cette étape
 * précise : impossible de distinguer une session expirée (non-retryable en
 * pratique) d'une limite de débit temporaire (retryable) sans modifier la
 * route ou dupliquer la logique de `handleUpload`, hors périmètre de ce
 * ticket. Ces échecs (et tout ce qui n'est identifiable ni comme une
 * `ApiRequestError` ni comme une coupure réseau) tombent donc dans
 * "ambiguous" plutôt que d'être *supposés* retryable ou non : la file les
 * réessaie prudemment, mais seulement un nombre de fois plafonné (voir
 * `maxAmbiguousAttempts` dans queue.ts), jamais indéfiniment.
 */
export function classifyUploadError(err: unknown): ClassifiedUploadError {
  if (err instanceof ApiRequestError) {
    return {
      tier: err.retryable ? "retryable" : "non-retryable",
      message: err.message,
    };
  }
  if (isNetworkFailure(err)) {
    return { tier: "retryable", message: NETWORK_MESSAGE };
  }
  return { tier: "ambiguous", message: UNKNOWN_MESSAGE };
}

/** Message affiché quand une erreur "ambiguous" a épuisé ses tentatives (voir queue.ts). */
export function ambiguousExhaustedMessage(): string {
  return EXHAUSTED_MESSAGE;
}
