/**
 * Trace, côté client uniquement, de la note actuellement en cours
 * d'enregistrement — écrite pendant que `useRecorder` est en état
 * `recording`/`paused`, effacée à un arrêt propre (`stopped`).
 *
 * Pourquoi ce n'est pas déductible du `NoteStore` seul : `Note.status` reste
 * `"recording"` indéfiniment tant que la queue d'upload (hors périmètre de ce
 * ticket, pas encore implémentée) n'a pas fait progresser la note — voir le
 * commentaire sur `NoteStore.appendSegment` dans `src/types/notes.ts`. Une
 * note normalement arrêtée par l'utilisateur et une note abandonnée par un
 * crash ont donc exactement la même forme en base. Ce marqueur local est ce
 * qui distingue les deux : s'il est encore présent au montage, la dernière
 * session connue ne s'est pas terminée proprement.
 *
 * Best-effort : `localStorage` peut être indisponible (navigation privée,
 * quota, contexte sans DOM) ou son contenu corrompu. Dans tous ces cas, on se
 * dégrade silencieusement — la reprise après refresh est un confort pour
 * l'utilisateur, jamais une garantie de données (celle-ci vient de
 * l'écriture immédiate de chaque segment en IndexedDB, déjà assurée par
 * `RecorderEngine`).
 */
const STORAGE_KEY = "voxnote:active-recording";

export interface ActiveRecordingMarker {
  noteId: string;
}

function getStorage(): Storage | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readActiveRecordingMarker(): ActiveRecordingMarker | undefined {
  const storage = getStorage();
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "noteId" in parsed &&
      typeof (parsed as { noteId: unknown }).noteId === "string"
    ) {
      return { noteId: (parsed as { noteId: string }).noteId };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function writeActiveRecordingMarker(noteId: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    const marker: ActiveRecordingMarker = { noteId };
    storage.setItem(STORAGE_KEY, JSON.stringify(marker));
  } catch {
    // Quota dépassé ou stockage bloqué : rien de plus à faire ici.
  }
}

export function clearActiveRecordingMarker(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // idem
  }
}
