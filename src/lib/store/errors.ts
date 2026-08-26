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

/**
 * Deux segments de la même note ne peuvent pas porter le même `seq` : le
 * contrat d'API fige le chemin du blob à `audio/{noteId}/{seq}` et la clé de
 * transcript à `[noteId, seq]`, donc un doublon écraserait silencieusement de
 * l'audio réellement enregistré. Détecté par un index unique `(noteId, seq)` —
 * voir `indexeddb.ts` (migration v2) et `memory.ts`.
 */
export class DuplicateSegmentSeqError extends Error {
  readonly noteId: string;
  readonly seq: number;

  constructor(noteId: string, seq: number) {
    super(`Un segment porte déjà le seq ${seq} pour la note ${noteId}`);
    this.name = "DuplicateSegmentSeqError";
    this.noteId = noteId;
    this.seq = seq;
  }
}
