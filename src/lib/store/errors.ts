/**
 * Erreurs typées de la couche de persistance. Une opération sur un identifiant
 * inexistant lève toujours l'une de ces erreurs — jamais une exception DOM brute
 * non gérée — afin que les appelants (hooks, queue d'upload) puissent distinguer
 * ce cas d'une panne de stockage.
 */

export class NoteNotFoundError extends Error {
  readonly noteId: string;

  constructor(noteId: string) {
    super(`Note introuvable : ${noteId}`);
    this.name = "NoteNotFoundError";
    this.noteId = noteId;
  }
}

export class SegmentNotFoundError extends Error {
  readonly segmentId: string;

  constructor(segmentId: string) {
    super(`Segment introuvable : ${segmentId}`);
    this.name = "SegmentNotFoundError";
    this.segmentId = segmentId;
  }
}
