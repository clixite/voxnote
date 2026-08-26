/**
 * Traduction des erreurs de capture audio en messages français exploitables
 * par un non-technicien (CLAUDE.md #6 et #7 du ticket) : jamais un
 * `NotAllowedError` brut affiché à l'écran.
 */
export type RecorderErrorCode =
  | "permission-denied"
  | "no-microphone"
  | "microphone-busy"
  | "unsupported-constraints"
  | "insecure-context"
  | "aborted"
  | "no-supported-mime-type"
  | "max-duration-reached"
  | "unknown";

export class RecorderError extends Error {
  constructor(
    public readonly code: RecorderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RecorderError";
  }
}

const MESSAGES: Record<RecorderErrorCode, string> = {
  "permission-denied":
    "Accès au microphone refusé. Autorisez le microphone pour ce site dans les réglages de votre navigateur, puis réessayez.",
  "no-microphone": "Aucun microphone n'a été détecté sur cet appareil.",
  "microphone-busy":
    "Le microphone est déjà utilisé par une autre application. Fermez-la, puis réessayez.",
  "unsupported-constraints": "Ce microphone n'est pas compatible avec l'enregistrement.",
  "insecure-context":
    "L'accès au microphone est bloqué car la connexion n'est pas sécurisée. Ouvrez VoxNote en HTTPS.",
  aborted: "L'accès au microphone a été interrompu. Réessayez.",
  "no-supported-mime-type":
    "Ce navigateur ne permet pas d'enregistrer de l'audio ici. Essayez avec une version à jour de Chrome, Safari ou Firefox.",
  "max-duration-reached":
    "Durée maximale de 2 heures atteinte : l'enregistrement a été arrêté automatiquement.",
  unknown: "Impossible d'accéder au microphone. Réessayez ou changez d'appareil.",
};

export function messageFor(code: RecorderErrorCode): string {
  return MESSAGES[code];
}

function codeForDomExceptionName(name: string | undefined): RecorderErrorCode {
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "permission-denied";
    case "SecurityError":
      return "insecure-context";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "no-microphone";
    case "NotReadableError":
    case "TrackStartError":
      return "microphone-busy";
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "unsupported-constraints";
    case "AbortError":
      return "aborted";
    default:
      return "unknown";
  }
}

/** Convertit une erreur `getUserMedia` (DOMException ou autre) en `RecorderError` français. */
export function toRecorderError(error: unknown): RecorderError {
  if (error instanceof RecorderError) return error;
  const name =
    error instanceof DOMException
      ? error.name
      : (error as { name?: string } | undefined)?.name;
  const code = codeForDomExceptionName(name);
  return new RecorderError(code, messageFor(code));
}

export function noSupportedMimeTypeError(): RecorderError {
  return new RecorderError("no-supported-mime-type", messageFor("no-supported-mime-type"));
}

export function maxDurationReachedError(): RecorderError {
  return new RecorderError("max-duration-reached", messageFor("max-duration-reached"));
}
