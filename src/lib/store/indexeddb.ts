import { openDB, type DBSchema, type IDBPDatabase } from "idb";

import type {
  AppendSegmentInput,
  CreateNoteInput,
  Note,
  NoteStore,
  Segment,
  Transcript,
} from "@/types/notes";

import { NoteNotFoundError, SegmentNotFoundError } from "./errors";
import { createInsertionClock } from "./insertion-order";
import { PENDING_SEGMENT_STATUSES } from "./pending";

/**
 * Nom et version de la base. La migration est versionnée dans `upgrade` : le
 * schéma évoluera aux phases suivantes (nouveaux champs, nouveaux index), donc
 * chaque palier futur s'ajoute comme un bloc `if (oldVersion < N)` de plus,
 * jamais en réécrivant les blocs précédents.
 */
export const NOTES_DB_NAME = "voxnote";
export const NOTES_DB_VERSION = 1;

/** Segment tel que conservé en base : le contrat public n'expose pas `insertedAt`. */
interface StoredSegment extends Segment {
  /** Horodatage d'insertion, pour `listPendingSegments` (« par ancienneté »). */
  insertedAt: number;
}

interface VoxNoteDB extends DBSchema {
  notes: {
    key: string;
    value: Note;
    indexes: { "by-createdAt": number };
  };
  segments: {
    key: string;
    value: StoredSegment;
    indexes: { "by-noteId": string; "by-status": Segment["status"] };
  };
  transcripts: {
    /** Clé composite : un transcript est identifié par sa note et son segment. */
    key: [string, number];
    value: Transcript;
    indexes: { "by-noteId": string };
  };
}

function upgrade(db: IDBPDatabase<VoxNoteDB>, oldVersion: number): void {
  if (oldVersion < 1) {
    const notes = db.createObjectStore("notes", { keyPath: "id" });
    notes.createIndex("by-createdAt", "createdAt");

    const segments = db.createObjectStore("segments", { keyPath: "id" });
    segments.createIndex("by-noteId", "noteId");
    segments.createIndex("by-status", "status");

    const transcripts = db.createObjectStore("transcripts", {
      keyPath: ["noteId", "seq"],
    });
    transcripts.createIndex("by-noteId", "noteId");
  }
}

function toPublicSegment(stored: StoredSegment): Segment {
  const segment: Partial<StoredSegment> = { ...stored };
  delete segment.insertedAt;
  return segment as Segment;
}

function defaultTitle(createdAt: number): string {
  return new Date(createdAt).toISOString();
}

export interface IndexedDbNoteStore extends NoteStore {
  /**
   * Ferme la connexion sous-jacente. Sans usage en production (la connexion
   * vit pour toute la durée de vie de l'onglet) ; sert aux tests à prouver que
   * les données survivent à une fermeture/réouverture réelle de la base, pas
   * seulement à une variable JS encore en mémoire.
   */
  close(): Promise<void>;
}

export interface CreateIndexedDbNoteStoreOptions {
  /** Surchage du nom de base — utilisé par les tests pour s'isoler les uns des autres. */
  dbName?: string;
}

/**
 * Implémentation `NoteStore` sur IndexedDB (via `idb`). Voir `src/lib/store/memory.ts`
 * pour le double en mémoire utilisé par les tests des autres modules : les deux
 * doivent rester observablement identiques (`contract.test.ts` le vérifie).
 */
export function createIndexedDbNoteStore(
  options: CreateIndexedDbNoteStoreOptions = {},
): IndexedDbNoteStore {
  const dbName = options.dbName ?? NOTES_DB_NAME;
  const nextInsertedAt = createInsertionClock();
  let dbPromise: Promise<IDBPDatabase<VoxNoteDB>> | null = null;

  function getDb(): Promise<IDBPDatabase<VoxNoteDB>> {
    dbPromise ??= openDB<VoxNoteDB>(dbName, NOTES_DB_VERSION, { upgrade });
    return dbPromise;
  }

  return {
    async createNote(input: CreateNoteInput): Promise<Note> {
      const db = await getDb();
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
      await db.add("notes", note);
      return note;
    },

    async getNote(id: string): Promise<Note | undefined> {
      const db = await getDb();
      return db.get("notes", id);
    },

    async listNotes(): Promise<Note[]> {
      const db = await getDb();
      // L'index range en ordre croissant ; on inverse pour l'antéchronologique.
      const ascending = await db.getAllFromIndex("notes", "by-createdAt");
      return ascending.reverse();
    },

    async updateNote(
      id: string,
      patch: Partial<Omit<Note, "id">>,
    ): Promise<Note> {
      const db = await getDb();
      const existing = await db.get("notes", id);
      if (!existing) {
        throw new NoteNotFoundError(id);
      }
      const updated: Note = { ...existing, ...patch, id: existing.id };
      await db.put("notes", updated);
      return updated;
    },

    async deleteNote(id: string): Promise<void> {
      const db = await getDb();
      const tx = db.transaction(
        ["notes", "segments", "transcripts"],
        "readwrite",
      );

      const segmentKeys = await tx
        .objectStore("segments")
        .index("by-noteId")
        .getAllKeys(id);
      const transcriptKeys = await tx
        .objectStore("transcripts")
        .index("by-noteId")
        .getAllKeys(id);

      await Promise.all([
        // Idempotent : supprimer une note déjà absente n'est pas une erreur.
        tx.objectStore("notes").delete(id),
        ...segmentKeys.map((key) => tx.objectStore("segments").delete(key)),
        ...transcriptKeys.map((key) =>
          tx.objectStore("transcripts").delete(key),
        ),
      ]);

      await tx.done;
    },

    async appendSegment(input: AppendSegmentInput): Promise<Segment> {
      const db = await getDb();
      const note = await db.get("notes", input.noteId);
      if (!note) {
        throw new NoteNotFoundError(input.noteId);
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
      await db.add("segments", stored);
      return toPublicSegment(stored);
    },

    async listSegments(noteId: string): Promise<Segment[]> {
      const db = await getDb();
      const stored = await db.getAllFromIndex("segments", "by-noteId", noteId);
      return stored.sort((a, b) => a.seq - b.seq).map(toPublicSegment);
    },

    async updateSegment(
      id: string,
      patch: Partial<Omit<Segment, "id" | "noteId" | "seq">>,
    ): Promise<Segment> {
      const db = await getDb();
      const existing = await db.get("segments", id);
      if (!existing) {
        throw new SegmentNotFoundError(id);
      }
      const updated: StoredSegment = { ...existing, ...patch, id: existing.id };
      await db.put("segments", updated);
      return toPublicSegment(updated);
    },

    async listPendingSegments(): Promise<Segment[]> {
      const db = await getDb();
      const lists = await Promise.all(
        PENDING_SEGMENT_STATUSES.map((status) =>
          db.getAllFromIndex("segments", "by-status", status),
        ),
      );
      return lists
        .flat()
        .sort((a, b) => a.insertedAt - b.insertedAt)
        .map(toPublicSegment);
    },

    async putTranscript(transcript: Transcript): Promise<void> {
      const db = await getDb();
      await db.put("transcripts", transcript);
    },

    async listTranscripts(noteId: string): Promise<Transcript[]> {
      const db = await getDb();
      const stored = await db.getAllFromIndex(
        "transcripts",
        "by-noteId",
        noteId,
      );
      return stored.sort((a, b) => a.seq - b.seq);
    },

    async close(): Promise<void> {
      if (dbPromise) {
        const db = await dbPromise;
        db.close();
        dbPromise = null;
      }
    },
  };
}
