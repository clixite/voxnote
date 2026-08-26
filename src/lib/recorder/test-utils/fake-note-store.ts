/**
 * Double en mémoire de `NoteStore` (src/types/notes.ts) pour les tests. Aucune
 * dépendance à `idb` : n'importe quel test unitaire peut l'utiliser sans
 * toucher à la vraie implémentation IndexedDB (développée en parallèle par un
 * autre agent contre le même contrat).
 */
import type {
  AppendSegmentInput,
  CreateNoteInput,
  Note,
  NoteStore,
  Segment,
  Transcript,
} from "@/types/notes";

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export interface FakeNoteStore extends NoteStore {
  /** Réservé aux tests : inspection directe sans passer par l'API async. */
  _notes: Map<string, Note>;
  _segments: Map<string, Segment>;
  _transcripts: Transcript[];
}

export function createFakeNoteStore(): FakeNoteStore {
  const notes = new Map<string, Note>();
  const segments = new Map<string, Segment>();
  const transcripts: Transcript[] = [];

  return {
    _notes: notes,
    _segments: segments,
    _transcripts: transcripts,

    async createNote(input: CreateNoteInput): Promise<Note> {
      const now = Date.now();
      const note: Note = {
        id: nextId("note"),
        createdAt: now,
        updatedAt: now,
        title: input.title ?? "Nouvelle note",
        lang: input.lang,
        durationMs: 0,
        status: "recording",
      };
      notes.set(note.id, note);
      return note;
    },

    async getNote(id: string): Promise<Note | undefined> {
      return notes.get(id);
    },

    async listNotes(): Promise<Note[]> {
      return [...notes.values()].sort((a, b) => b.createdAt - a.createdAt);
    },

    async updateNote(id: string, patch: Partial<Omit<Note, "id">>): Promise<Note> {
      const existing = notes.get(id);
      if (!existing) throw new Error(`Note introuvable : ${id}`);
      const updated: Note = { ...existing, ...patch, updatedAt: Date.now() };
      notes.set(id, updated);
      return updated;
    },

    async deleteNote(id: string): Promise<void> {
      notes.delete(id);
      const keptSegments = [...segments.values()].filter((s) => s.noteId !== id);
      segments.clear();
      for (const segment of keptSegments) segments.set(segment.id, segment);
      const keptTranscripts = transcripts.filter((t) => t.noteId !== id);
      transcripts.length = 0;
      transcripts.push(...keptTranscripts);
    },

    async appendSegment(input: AppendSegmentInput): Promise<Segment> {
      const segment: Segment = {
        id: nextId("segment"),
        noteId: input.noteId,
        seq: input.seq,
        blob: input.blob,
        mimeType: input.mimeType,
        durationMs: input.durationMs,
        status: "local",
        attempts: 0,
      };
      segments.set(segment.id, segment);
      return segment;
    },

    async listSegments(noteId: string): Promise<Segment[]> {
      return [...segments.values()]
        .filter((s) => s.noteId === noteId)
        .sort((a, b) => a.seq - b.seq);
    },

    async updateSegment(
      id: string,
      patch: Partial<Omit<Segment, "id" | "noteId" | "seq">>,
    ): Promise<Segment> {
      const existing = segments.get(id);
      if (!existing) throw new Error(`Segment introuvable : ${id}`);
      const updated: Segment = { ...existing, ...patch };
      segments.set(id, updated);
      return updated;
    },

    async listPendingSegments(): Promise<Segment[]> {
      return [...segments.values()]
        .filter((s) => s.status !== "done")
        .sort((a, b) => a.seq - b.seq);
    },

    async putTranscript(transcript: Transcript): Promise<void> {
      transcripts.push(transcript);
    },

    async listTranscripts(noteId: string): Promise<Transcript[]> {
      return transcripts.filter((t) => t.noteId === noteId).sort((a, b) => a.seq - b.seq);
    },
  };
}
