/**
 * Traduction des erreurs de capture audio en messages français exploitables
 * par un non-technicien (CLAUDE.md #6 et #7 du ticket) : jamais un
 * `NotAllowedError` brut affiché à l'écran. Tutoiement partout, sans
 * exception (CLAUDE.md #6) — et chaque message dit non seulement ce qui a
 * échoué, mais ce qu'il y a à faire ensuite.
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
  | "note-not-found"
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
    "Accès au microphone refusé. Autorise le microphone pour VoxNote dans les réglages de ton navigateur, puis réessaie.",
  "no-microphone":
    "Aucun microphone n'a été détecté sur cet appareil. Branches-en un ou vérifie son branchement, puis réessaie.",
  "microphone-busy":
    "Le microphone est déjà utilisé par une autre application. Ferme-la, puis réessaie.",
  "unsupported-constraints":
    "Ce microphone n'est pas compatible avec l'enregistrement. Essaie avec un autre microphone si tu en as un.",
  "insecure-context":
    "L'accès au microphone est bloqué : la connexion n'est pas sécurisée. Ouvre VoxNote via une adresse commençant par https://, puis réessaie.",
  aborted: "L'accès au microphone a été interrompu. Réessaie.",
  "no-supported-mime-type":
    "Ce navigateur ne permet pas d'enregistrer de l'audio ici. Essaie avec une version à jour de Chrome, Safari ou Firefox.",
  "max-duration-reached":
    "Durée maximale de 2 heures atteinte : l'enregistrement s'est arrêté automatiquement, mais tout ce qui a été enregistré est sauvegardé. Démarre un nouvel enregistrement pour continuer.",
  "note-not-found":
    "Cette note n'existe plus : impossible de reprendre l'enregistrement. Démarres-en un nouveau.",
  unknown:
    "Impossible d'accéder au microphone, pour une raison inconnue. Réessaie ; si ça persiste, redémarre ton navigateur ou utilise un autre appareil.",
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

export function noteNotFoundError(): RecorderError {
  return new RecorderError("note-not-found", messageFor("note-not-found"));
}
