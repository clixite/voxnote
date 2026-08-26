/**
 * Contrat des routes API, figé par l'orchestrateur avant implémentation.
 * Frontend et backend codent contre ces types en parallèle.
 *
 * Règle qui gouverne tout ce fichier : **le serveur est sans état**. Il n'y a
 * aucune base de données (cf. docs/ARCHITECTURE.md). Le client est la source de
 * vérité : c'est lui qui tient l'état des segments en IndexedDB, qui pilote la
 * séquence, et qui réessaie. Le serveur ne fait qu'exécuter une opération et
 * répondre.
 */

import type { LangSetting } from "./notes";

export type ProviderId = "groq" | "openai" | "gladia";

/**
 * Corps d'erreur commun à toutes les routes.
 * `message` est en français et affichable tel quel à l'utilisateur.
 * `retryable` pilote la queue de réessai côté client : il ne devine jamais.
 */
export interface ApiErrorBody {
  error: ApiErrorCode;
  message: string;
  retryable: boolean;
}

export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "BAD_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "AUDIO_UNREADABLE"
  | "PROVIDER_QUOTA"
  | "PROVIDER_UNAVAILABLE"
  | "SERVER_MISCONFIGURED";

/* -------------------------------------------------------------------------- */
/* POST /api/blob/upload-token                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Handshake de l'upload client direct vers Vercel Blob.
 *
 * L'audio ne transite JAMAIS par une route API : la limite de body des
 * fonctions serverless (~4,5 Mo) serait atteinte dès un segment de quelques
 * minutes. Le client demande un jeton à cette route, puis téléverse
 * directement vers Blob.
 *
 * Les formes exactes de la requête et de la réponse sont imposées par
 * `@vercel/blob/client` (`upload()` côté client, `handleUpload()` côté route) :
 * la route est un passe-plat. Ce qui nous appartient, et qui est contractuel :
 *
 * - chemin du blob : `audio/{noteId}/{seq}` — c'est ce préfixe qui permet à la
 *   suppression et au cron de purge de retrouver les blobs d'une note sans
 *   base de données ;
 * - `clientPayload` : le JSON sérialisé de `UploadTokenPayload` ci-dessous ;
 * - la route valide `mimeType` (liste blanche), la taille annoncée et exige une
 *   session valide. Un jeton n'est jamais émis sans ces trois contrôles.
 */
export interface UploadTokenPayload {
  noteId: string;
  seq: number;
  mimeType: string;
  sizeBytes: number;
}

/** Types audio acceptés à l'upload. Tout le reste est refusé en 400. */
export const ALLOWED_AUDIO_MIME_TYPES = [
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mpeg",
  "audio/ogg;codecs=opus",
] as const;

/** Plafond par segment. Un segment de 5 min pèse quelques Mo : large marge. */
export const MAX_SEGMENT_BYTES = 25 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/* POST /api/transcribe                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Transcrit UN segment déjà présent dans Blob, et répond avec le texte.
 *
 * Volontairement **synchrone**, sans identifiant de tâche ni route de
 * polling — contrairement à ce que prévoyait le backlog initial. Un job
 * asynchrone impose de stocker son état quelque part ; sans base de données,
 * ce « quelque part » n'existe pas côté serveur. Le client, lui, a déjà
 * IndexedDB et sait exactement quels segments restent à traiter : il rejoue
 * simplement la requête. Une route de polling aurait donc soit réintroduit une
 * base, soit menti sur un état qu'elle ne pouvait pas connaître.
 *
 * Le client appelle cette route une fois par segment et peut en paralléliser
 * plusieurs : l'ordre de restitution vient de `seq`, jamais de l'ordre des
 * réponses.
 */
export interface TranscribeRequestBody {
  noteId: string;
  seq: number;
  /** URL renvoyée par Vercel Blob après l'upload. Jamais le binaire. */
  blobUrl: string;
  mimeType: string;
  /** `auto` laisse la détection au provider. */
  lang: LangSetting;
}

export interface TranscribeResponseBody {
  noteId: string;
  seq: number;
  text: string;
  /** Langue détectée ou forcée, code ISO renvoyé par le provider. */
  language: string;
  provider: ProviderId;
  durationMs: number;
}

/* -------------------------------------------------------------------------- */
/* DELETE /api/notes/[noteId]                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Supprime tous les blobs audio de la note, par préfixe `audio/{noteId}/`.
 *
 * Le serveur liste et supprime lui-même : le client ne transmet aucune liste
 * d'URL. Se fier à une liste fournie par le client laisserait passer un blob
 * oublié, donc de l'audio orphelin — un manquement RGPD, pas un bug d'affichage.
 *
 * Le client supprime sa note, ses segments et ses transcripts localement. Les
 * deux moitiés doivent réussir pour que la suppression soit complète : si la
 * route échoue, le client garde la note marquée en erreur plutôt que de la
 * faire disparaître de l'écran en laissant l'audio en ligne.
 */
export interface DeleteNoteResponseBody {
  deletedBlobs: number;
}

/* -------------------------------------------------------------------------- */
/* GET /api/cron/purge                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Purge les blobs audio de plus de `AUDIO_RETENTION_DAYS` jours.
 * Protégée par `CRON_SECRET`, hors du middleware de session (Vercel Cron
 * appelle sans cookie). Le chemin exclu du middleware doit être exact, jamais
 * un préfixe : un préfixe ouvrirait tout un sous-arbre.
 */
export interface PurgeResponseBody {
  scanned: number;
  deleted: number;
}

export const AUDIO_RETENTION_DAYS = 7;
