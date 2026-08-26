/**
 * Dérive `Note.status` et `Note.text` à partir de l'état de ses segments —
 * logique pure, appelée par la file d'upload (queue.ts) après chaque
 * changement de statut de segment. `NoteStore.updateNote` ne dérive jamais
 * rien lui-même (voir le commentaire de `appendSegment` dans
 * src/types/notes.ts) : c'est le rôle de l'appelant, ici la file.
 *
 * Frontière avec l'écran d'enregistrement : `Note.status` vaut `"recording"`
 * dès la création (voir memory.ts/indexeddb.ts) et cette fonction ne le
 * quitte jamais toute seule — seul RecorderScreen sait quand l'utilisateur a
 * réellement arrêté d'enregistrer (la file, elle, ignore si une session est
 * encore active). Elle bascule explicitement la note en `"processing"` à
 * l'arrêt ; à partir de là, `deriveNoteRollup` prend le relais.
 */
import type { NoteStatus, Segment, Transcript } from "@/types/notes";

export interface NoteRollup {
  status: NoteStatus;
  /** `undefined` : ne pas toucher `Note.text` (rien de neuf à assembler, ou aucun segment terminé). */
  text: string | undefined;
}

/** Assemble le transcript dans l'ordre des `seq`, jamais l'ordre d'arrivée des réponses. */
function assembleText(transcripts: Transcript[]): string {
  return [...transcripts]
    .sort((a, b) => a.seq - b.seq)
    .map((t) => t.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/**
 * Calcule le rollup pour une note qui n'est plus en cours d'enregistrement
 * (voir la frontière documentée en tête de fichier). Ne rien appeler pour une
 * note encore `"recording"` : c'est à l'appelant de le garder ainsi.
 */
export function deriveNoteRollup(
  segments: Segment[],
  transcripts: Transcript[],
): NoteRollup | undefined {
  if (segments.length === 0) return undefined;

  const doneCount = segments.filter((s) => s.status === "done").length;
  const errorCount = segments.filter((s) => s.status === "error").length;
  const stillWorking = segments.length - doneCount - errorCount > 0;

  let status: NoteStatus;
  if (stillWorking) {
    status = "processing";
  } else if (errorCount === 0) {
    status = "done";
  } else if (doneCount === 0) {
    status = "error";
  } else {
    status = "partial";
  }

  // Le texte n'est assemblé que depuis les segments effectivement transcrits :
  // un segment en erreur ne doit jamais faire "sauter" un morceau du texte en
  // silence, mais on n'attend pas non plus qu'il se résolve pour donner à lire
  // ce qui est déjà prêt (partiel, mais lisible).
  const text = doneCount > 0 ? assembleText(transcripts) : undefined;

  return { status, text };
}

export interface NoteProgress {
  total: number;
  uploadedCount: number;
  transcribedCount: number;
  errorSegments: Array<{ segmentId: string; seq: number; message: string }>;
}

/**
 * Compte utilisé par l'UI (P3-5) : indépendant du rollup, jamais deviné à
 * partir du texte assemblé.
 *
 * `uploadedCount` compte les segments qui ONT un `blobUrl`, pas une liste de
 * statuts (C6, revue) : un segment dont l'upload a réussi puis dont la
 * TRANSCRIPTION échoue passe en `"error"` tout en gardant son `blobUrl` — le
 * compter par statut le faisait sortir du compte "envoyés", donnant
 * l'impression qu'un envoi déjà réussi avait reculé (aucun octet perdu,
 * pourtant l'inverse exact du "rassurer" visé par cette UI). `blobUrl` est
 * déjà le signal dont `queue.ts` se sert pour décider de sauter l'upload à
 * la reprise : une seule source de vérité plutôt que deux listes à tenir
 * synchronisées.
 */
export function computeNoteProgress(segments: Segment[]): NoteProgress {
  const uploadedCount = segments.filter((s) => Boolean(s.blobUrl)).length;
  const transcribedCount = segments.filter((s) => s.status === "done").length;
  const errorSegments = segments
    .filter((s) => s.status === "error")
    .map((s) => ({ segmentId: s.id, seq: s.seq, message: s.error ?? "" }));

  return { total: segments.length, uploadedCount, transcribedCount, errorSegments };
}
