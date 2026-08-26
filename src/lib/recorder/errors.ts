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
  | "duplicate-segment"
  | "storage-full"
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
  "duplicate-segment":
    "Cette note est déjà en cours d'enregistrement ailleurs, probablement dans un autre onglet. Termine-la là-bas, ou arrête cet enregistrement-ci : les deux ne peuvent pas continuer en même temps sur la même note.",
  "storage-full":
    "Le stockage de cet appareil est plein : l'enregistrement s'est arrêté. Tout ce qui a déjà été enregistré est intact et sauvegardé. Libère de la place sur ton appareil, puis démarre un nouvel enregistrement.",
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

/**
 * Échec définitif (après plusieurs essais) de l'écriture d'un segment dans le
 * `NoteStore` — typiquement un quota de stockage local saturé. Dit la vérité :
 * l'enregistrement s'arrête, mais rien de ce qui a déjà été écrit n'est perdu
 * (voir `RecorderEngine.closeCurrentSegment`, qui ne libère jamais le blob en
 * mémoire avant un `appendSegment` réussi).
 */
export function storageFullError(): RecorderError {
  return new RecorderError("storage-full", messageFor("storage-full"));
}

export function duplicateSegmentError(): RecorderError {
  return new RecorderError("duplicate-segment", messageFor("duplicate-segment"));
}

/**
 * Reconnaît, par son nom, une erreur du `NoteStore` dont on sait qu'elle ne
 * peut PAS être transitoire : retenter ne changera rien. Renvoie `undefined`
 * pour tout le reste (quota, base momentanément bloquée...), qui reste
 * candidat à une reprise (voir `RecorderEngine.persistSegment`).
 *
 * La question n'est jamais « comment signaler cette erreur » mais « est-ce
 * que réessayer a un sens ». Si non, il faut échouer tout de suite avec un
 * message qui reflète la vraie cause :
 * - `DuplicateSegmentSeqError` (contrainte d'unicité `(noteId, seq)` posée
 *   par la couche de persistance) : le même `seq` violera la contrainte à
 *   chaque tentative — observé quand la même note enregistre depuis deux
 *   onglets à la fois. Annoncer « stockage plein » ici serait faux et ferait
 *   perdre du temps à l'utilisateur à chercher de l'espace disque pour rien.
 * - `NoteNotFoundError` : la note a disparu (supprimée entre-temps,
 *   éventuellement depuis un autre onglet) ; réessayer trois fois ne la fera
 *   pas revenir.
 *
 * Identifié par `.name` plutôt que par `instanceof` (comme
 * `codeForDomExceptionName` ci-dessus pour les `DOMException`) : ce module
 * n'a pas besoin d'importer les classes concrètes de `src/lib/store/errors.ts`
 * pour rester correct, et ça fonctionne pareil quelle que soit
 * l'implémentation de `NoteStore` (IndexedDB, mémoire, une future autre) tant
 * qu'elle respecte la convention `this.name = "NomDeClasseError"`.
 */
export function nonRetryableStoreError(rawError: unknown): RecorderError | undefined {
  const name = (rawError as { name?: string } | undefined)?.name;
  switch (name) {
    case "DuplicateSegmentSeqError":
      return duplicateSegmentError();
    case "NoteNotFoundError":
      return noteNotFoundError();
    default:
      return undefined;
  }
}
