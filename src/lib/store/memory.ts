import type {
  AppendSegmentInput,
  CreateNoteInput,
  Note,
  NoteStore,
  Segment,
  Transcript,
} from "@/types/notes";

import {
  DuplicateSegmentSeqError,
  NoteNotFoundError,
  SegmentNotFoundError,
} from "./errors";
import { createInsertionClock } from "./insertion-order";
import { isPendingUploadStatus } from "./pending";

/** Segment tel que conservé en interne : le contrat public n'expose pas `insertedAt`. */
interface StoredSegment extends Segment {
  insertedAt: number;
}

function toPublicSegment(stored: StoredSegment): Segment {
  const segment: Partial<StoredSegment> = { ...stored };
  delete segment.insertedAt;
  return segment as Segment;
}

function defaultTitle(createdAt: number): string {
  return new Date(createdAt).toISOString();
}

/**
 * Double en mémoire de `NoteStore`, pour les tests des modules qui consomment
 * l'interface sans avoir besoin d'une vraie base. Doit rester observablement
 * identique à `src/lib/store/indexeddb.ts` : mêmes tris, même atomicité de
 * suppression, mêmes erreurs. Voir `contract.test.ts`, qui fait passer les deux
 * implémentations par la même batterie d'assertions.
 */
export function createMemoryNoteStore(): NoteStore {
  const notes = new Map<string, Note>();
  const segments = new Map<string, StoredSegment>();
  const transcripts = new Map<string, Transcript>();
  const nextInsertedAt = createInsertionClock();

  function transcriptKey(noteId: string, seq: number): string {
    return `${noteId}:${seq}`;
  }

  return {
    async createNote(input: CreateNoteInput): Promise<Note> {
      const now = Date.now();
      const note: Note = {
        id: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        title: input.title ?? defaultTitle(now),
        lang: input.lang,
        durationMs: 0,
        status: "recording",
      };
      notes.set(note.id, note);
      return { ...note };
    },

    async getNote(id: string): Promise<Note | undefined> {
      const note = notes.get(id);
      return note ? { ...note } : undefined;
    },

    async listNotes(): Promise<Note[]> {
      return [...notes.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((note) => ({ ...note }));
    },

    async updateNote(
      id: string,
      patch: Partial<Omit<Note, "id">>,
    ): Promise<Note> {
      const existing = notes.get(id);
      if (!existing) {
        throw new NoteNotFoundError(id);
      }
      const updated: Note = {
        ...existing,
        ...patch,
        id: existing.id,
        updatedAt: patch.updatedAt ?? Date.now(),
      };
      notes.set(id, updated);
      return { ...updated };
    },

    async deleteNote(id: string): Promise<void> {
      // Idempotent : supprimer une note déjà absente n'est pas une erreur.
      notes.delete(id);
      for (const segment of segments.values()) {
        if (segment.noteId === id) {
          segments.delete(segment.id);
        }
      }
      for (const [key, transcript] of transcripts) {
        if (transcript.noteId === id) {
          transcripts.delete(key);
        }
      }
    },

    async appendSegment(input: AppendSegmentInput): Promise<Segment> {
      if (!notes.has(input.noteId)) {
        throw new NoteNotFoundError(input.noteId);
      }
      for (const segment of segments.values()) {
        if (segment.noteId === input.noteId && segment.seq === input.seq) {
          throw new DuplicateSegmentSeqError(input.noteId, input.seq);
        }
      }
      const stored: StoredSegment = {
        id: crypto.randomUUID(),
        noteId: input.noteId,
        seq: input.seq,
        blob: input.blob,
        mimeType: input.mimeType,
        durationMs: input.durationMs,
        status: "local",
        attempts: 0,
        insertedAt: nextInsertedAt(),
      };
      segments.set(stored.id, stored);
      return toPublicSegment(stored);
    },

    async listSegments(noteId: string): Promise<Segment[]> {
      return [...segments.values()]
        .filter((segment) => segment.noteId === noteId)
        .sort((a, b) => a.seq - b.seq)
        .map(toPublicSegment);
    },

    async updateSegment(
      id: string,
      patch: Partial<Omit<Segment, "id" | "noteId" | "seq">>,
    ): Promise<Segment> {
      const existing = segments.get(id);
      if (!existing) {
        throw new SegmentNotFoundError(id);
      }
      const updated: StoredSegment = { ...existing, ...patch, id: existing.id };
      segments.set(id, updated);
      return toPublicSegment(updated);
    },

    async listPendingSegments(): Promise<Segment[]> {
      return [...segments.values()]
        .filter((segment) => isPendingUploadStatus(segment.status))
        .sort((a, b) => a.insertedAt - b.insertedAt)
        .map(toPublicSegment);
    },

    async putTranscript(transcript: Transcript): Promise<void> {
      transcripts.set(transcriptKey(transcript.noteId, transcript.seq), {
        ...transcript,
      });
    },

    async listTranscripts(noteId: string): Promise<Transcript[]> {
      return [...transcripts.values()]
        .filter((transcript) => transcript.noteId === noteId)
        .sort((a, b) => a.seq - b.seq)
        .map((transcript) => ({ ...transcript }));
    },
  };
}
