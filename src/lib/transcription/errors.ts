/**
 * Traduction des erreurs de transcription (provider externe ou stockage Blob)
 * en messages français exploitables par un non-technicien, avec un indicateur
 * `retryable` qui pilote le retry exponentiel (`./retry.ts`) et, une fois les
 * tentatives épuisées, la queue de réessai côté client — qui ne devine jamais
 * si elle doit rejouer la requête.
 *
 * Même esprit que `src/lib/recorder/errors.ts` : un code stable, un message
 * fixe par code (jamais le détail technique brut), un détail réservé aux logs
 * serveur. `code` est un sous-ensemble d'`ApiErrorCode` (`src/types/api.ts`,
 * contrat figé) : la route n'a qu'à recopier `code`/`message`/`retryable`
 * dans `ApiErrorBody`, jamais à réinterpréter quoi que ce soit.
 */

import type { ApiErrorCode } from "@/types/api";

export type TranscriptionErrorCode = Extract<
  ApiErrorCode,
  | "AUDIO_UNREADABLE"
  | "PROVIDER_QUOTA"
  | "PROVIDER_UNAVAILABLE"
  | "SERVER_MISCONFIGURED"
>;

/**
 * Retryable par défaut pour chaque code. `PROVIDER_QUOTA` est le seul cas où
 * l'appelant doit trancher au cas par cas (quota de débit, transitoire, vs.
 * quota mensuel épuisé, définitif) — voir `providerQuotaError`.
 */
const DEFAULT_RETRYABLE: Record<TranscriptionErrorCode, boolean> = {
  AUDIO_UNREADABLE: false,
  PROVIDER_QUOTA: true,
  PROVIDER_UNAVAILABLE: true,
  SERVER_MISCONFIGURED: false,
};

/**
 * Message fixe par code, affichable tel quel à l'utilisateur. Ne varie
 * jamais avec le provider ni le détail technique : un non-technicien ne doit
 * jamais voir « insufficient_quota » ou une trace HTTP.
 */
const MESSAGES: Record<TranscriptionErrorCode, string> = {
  AUDIO_UNREADABLE:
    "Ce segment audio n'a pas pu être transcrit : le fichier semble illisible ou dans un format non pris en charge. Tu peux réessayer d'enregistrer ce passage.",
  PROVIDER_QUOTA:
    "Le service de transcription est momentanément saturé. Réessaie dans quelques minutes.",
  PROVIDER_UNAVAILABLE:
    "Le service de transcription est momentanément inaccessible (réseau ou service en panne). Réessaie dans quelques instants.",
  SERVER_MISCONFIGURED:
    "Configuration du serveur invalide. Contacte l'administrateur.",
};

export class TranscriptionError extends Error {
  readonly code: TranscriptionErrorCode;
  readonly retryable: boolean;
  /** Détail technique réservé aux logs serveur — jamais renvoyé au client. */
  readonly detail?: string;

  constructor(
    code: TranscriptionErrorCode,
    retryable: boolean = DEFAULT_RETRYABLE[code],
    detail?: string,
  ) {
    super(MESSAGES[code]);
    this.name = "TranscriptionError";
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
  }
}

export function audioUnreadableError(detail?: string): TranscriptionError {
  return new TranscriptionError("AUDIO_UNREADABLE", false, detail);
}

/**
 * `retryable` doit être décidé par l'appelant : un 429 « rate limit »
 * (débit dépassé sur quelques secondes) est transitoire, un 429
 * « insufficient_quota » / « billing » (quota mensuel ou crédit épuisé) ne
 * l'est pas — retenter trois fois ne fait alors que perdre du temps et
 * brûler le quota restant pour rien.
 */
export function providerQuotaError(
  retryable: boolean,
  detail?: string,
): TranscriptionError {
  return new TranscriptionError("PROVIDER_QUOTA", retryable, detail);
}

export function providerUnavailableError(detail?: string): TranscriptionError {
  return new TranscriptionError("PROVIDER_UNAVAILABLE", true, detail);
}

export function serverMisconfiguredError(detail?: string): TranscriptionError {
  return new TranscriptionError("SERVER_MISCONFIGURED", false, detail);
}
