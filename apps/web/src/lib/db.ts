import { openDB, type IDBPDatabase } from 'idb';

export interface NoteRecord {
  id: string;
  title: string;
  transcript: string;
  status: 'recording' | 'processing' | 'done' | 'error';
  error?: string;
  durationMs?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SegmentRecord {
  id: string;
  noteId: string;
  index: number;
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

const DB_NAME = 'voxnote';
const SEGMENTS = 'segments';
const NOTES = 'notes';

let dbp: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbp) {
    dbp = openDB(DB_NAME, 1, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(SEGMENTS)) d.createObjectStore(SEGMENTS, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(NOTES)) d.createObjectStore(NOTES, { keyPath: 'id' });
      },
    });
  }
  return dbp;
}

export async function saveSegment(seg: SegmentRecord): Promise<void> {
  await (await db()).put(SEGMENTS, seg);
}

export async function getSegments(noteId: string): Promise<SegmentRecord[]> {
  const d = await db();
  const all = await d.getAll(SEGMENTS);
  return all.filter((s) => s.noteId === noteId).sort((a, b) => a.index - b.index);
}

export async function deleteSegments(noteId: string): Promise<void> {
  const d = await db();
  const all = await d.getAll(SEGMENTS);
  await Promise.all(all.filter((s) => s.noteId === noteId).map((s) => d.delete(SEGMENTS, s.id)));
}

export async function saveNote(note: NoteRecord): Promise<void> {
  await (await db()).put(NOTES, note);
}

export async function listNotes(): Promise<NoteRecord[]> {
  const all = await (await db()).getAll(NOTES);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getNote(id: string): Promise<NoteRecord | undefined> {
  return (await db()).get(NOTES, id);
}

export async function deleteNote(id: string): Promise<void> {
  const d = await db();
  await d.delete(NOTES, id);
  await deleteSegments(id);
}
