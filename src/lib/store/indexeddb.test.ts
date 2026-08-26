/**
 * Tests spécifiques à la vraie implémentation IndexedDB (via `fake-indexeddb`) :
 * tout ce que le double en mémoire ne peut pas prouver — persistance réelle à
 * travers une fermeture/réouverture de connexion, et absence de ligne orpheline
 * vérifiée en interrogeant les object stores directement, sans passer par
 * l'abstraction `NoteStore`.
 */
import { openDB } from "idb";
import { afterEach, describe, expect, it } from "vitest";

import { createIndexedDbNoteStore, NOTES_DB_VERSION } from "./indexeddb";
import { DuplicateSegmentSeqError } from "./errors";

import "./test-fake-idb";

let dbCounter = 0;
function freshDbName(): string {
  dbCounter += 1;
  return `voxnote-test-${dbCounter}`;
}

const openStores: string[] = [];
afterEach(async () => {
  // fake-indexeddb garde les bases en mémoire pour tout le process : on nettoie
  // pour ne pas laisser un test polluer le suivant si un nom est réutilisé.
  await Promise.all(openStores.splice(0).map((name) => indexedDB.deleteDatabase(name)));
});

describe("createIndexedDbNoteStore", () => {
  it("crée les object stores et index attendus (notes, segments, transcripts)", async () => {
    const dbName = freshDbName();
    openStores.push(dbName);
    const store = createIndexedDbNoteStore({ dbName });
    await store.createNote({ lang: "fr" }); // force l'ouverture / la migration

    const raw = await openDB(dbName, NOTES_DB_VERSION);
    expect([...raw.objectStoreNames].sort()).toEqual([
      "notes",
      "segments",
      "transcripts",
    ]);

    const notesTx = raw.transaction("notes");
    expect([...notesTx.store.indexNames]).toContain("by-createdAt");

    const segmentsTx = raw.transaction("segments");
    expect([...segmentsTx.store.indexNames].sort()).toEqual([
      "by-noteId",
      "by-noteId-seq",
      "by-status",
    ]);

    const transcriptsTx = raw.transaction("transcripts");
    expect([...transcriptsTx.store.indexNames]).toContain("by-noteId");

    raw.close();
    await store.close();
  });

  it("deleteNote ne laisse aucune ligne orpheline dans les stores bruts", async () => {
    const dbName = freshDbName();
    openStores.push(dbName);
    const store = createIndexedDbNoteStore({ dbName });

    const noteA = await store.createNote({ lang: "fr" });
    const noteB = await store.createNote({ lang: "en" });

    await store.appendSegment({
      noteId: noteA.id,
      seq: 0,
      blob: new Blob(["a0"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });
    await store.appendSegment({
      noteId: noteA.id,
      seq: 1,
      blob: new Blob(["a1"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });
    const keepSegment = await store.appendSegment({
      noteId: noteB.id,
      seq: 0,
      blob: new Blob(["b0"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    await store.putTranscript({
      noteId: noteA.id,
      seq: 0,
      text: "a",
      provider: "groq",
      createdAt: Date.now(),
    });
    await store.putTranscript({
      noteId: noteB.id,
      seq: 0,
      text: "b",
      provider: "groq",
      createdAt: Date.now(),
    });

    await store.deleteNote(noteA.id);

    // Inspection directe des stores, en contournant complètement `NoteStore`.
    const raw = await openDB(dbName, NOTES_DB_VERSION);

    const remainingNotes = await raw.getAll("notes");
    expect(remainingNotes.map((n) => n.id)).toEqual([noteB.id]);

    const remainingSegments = await raw.getAll("segments");
    expect(remainingSegments.map((s) => s.id)).toEqual([keepSegment.id]);
    expect(
      remainingSegments.some((s) => s.noteId === noteA.id),
    ).toBe(false);

    const remainingTranscripts = await raw.getAll("transcripts");
    expect(remainingTranscripts).toHaveLength(1);
    expect(remainingTranscripts[0].noteId).toBe(noteB.id);

    raw.close();
    await store.close();
  });

  it("les données survivent à une fermeture puis réouverture de la base", async () => {
    const dbName = freshDbName();
    openStores.push(dbName);

    const first = createIndexedDbNoteStore({ dbName });
    const note = await first.createNote({ lang: "fr", title: "Réunion" });
    await first.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["contenu"]),
      mimeType: "audio/webm",
      durationMs: 42_000,
    });
    await first.close(); // simule la fin de vie de l'onglet avant refresh

    const second = createIndexedDbNoteStore({ dbName });
    const reloadedNote = await second.getNote(note.id);
    const reloadedSegments = await second.listSegments(note.id);

    expect(reloadedNote).toEqual(note);
    expect(reloadedSegments).toHaveLength(1);
    const reloadedSegment = reloadedSegments[0]!;
    expect(reloadedSegment.durationMs).toBe(42_000);
    expect(reloadedSegment.blob.size).toBe(new Blob(["contenu"]).size);

    await second.close();
  });

  it("les erreurs levées sont des erreurs typées, pas des DOMException brutes", async () => {
    const dbName = freshDbName();
    openStores.push(dbName);
    const store = createIndexedDbNoteStore({ dbName });

    await expect(
      store.updateNote("absente", { status: "done" }),
    ).rejects.toMatchObject({ name: "NoteNotFoundError" });

    await store.close();
  });

  it("un doublon de seq est rejeté par l'index unique, pas juste par notre code", async () => {
    const dbName = freshDbName();
    openStores.push(dbName);
    const store = createIndexedDbNoteStore({ dbName });
    const note = await store.createNote({ lang: "fr" });

    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["premier"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    await expect(
      store.appendSegment({
        noteId: note.id,
        seq: 0,
        blob: new Blob(["concurrent"]),
        mimeType: "audio/webm",
        durationMs: 1000,
      }),
    ).rejects.toBeInstanceOf(DuplicateSegmentSeqError);

    // Vérifié au ras de la base : un seul segment, l'audio original n'a pas
    // été écrasé par le doublon rejeté.
    const raw = await openDB(dbName, NOTES_DB_VERSION);
    const rawSegments = await raw.getAll("segments");
    expect(rawSegments).toHaveLength(1);
    expect(rawSegments[0].blob.size).toBe(new Blob(["premier"]).size);
    raw.close();

    await store.close();
  });

  it("une base créée en v1 (avant l'index unique) migre vers v2 sans perte, et applique le nouvel index unique", async () => {
    const dbName = freshDbName();
    openStores.push(dbName);

    // Reproduit exactement le schéma v1 tel qu'il existait avant B4, pour
    // vérifier que `upgrade()` migre une vraie base existante — pas seulement
    // une base neuve qui traverse les deux blocs `if` d'un coup.
    const legacy = await openDB(dbName, 1, {
      upgrade(db) {
        const notes = db.createObjectStore("notes", { keyPath: "id" });
        notes.createIndex("by-createdAt", "createdAt");
        const segments = db.createObjectStore("segments", { keyPath: "id" });
        segments.createIndex("by-noteId", "noteId");
        segments.createIndex("by-status", "status");
        const transcripts = db.createObjectStore("transcripts", {
          keyPath: ["noteId", "seq"],
        });
        transcripts.createIndex("by-noteId", "noteId");
      },
    });

    const legacyNote = {
      id: "legacy-note",
      createdAt: 1,
      updatedAt: 1,
      title: "Ancienne note",
      lang: "fr",
      durationMs: 60_000,
      status: "done",
    };
    await legacy.add("notes", legacyNote);
    await legacy.add("segments", {
      id: "legacy-seg-0",
      noteId: legacyNote.id,
      seq: 0,
      blob: new Blob(["a"]),
      mimeType: "audio/webm",
      durationMs: 60_000,
      status: "done",
      attempts: 0,
      insertedAt: 1,
    });
    legacy.close();

    const store = createIndexedDbNoteStore({ dbName });

    // Rien n'a été perdu par la migration.
    const migratedNote = await store.getNote(legacyNote.id);
    expect(migratedNote?.title).toBe("Ancienne note");
    const segments = await store.listSegments(legacyNote.id);
    expect(segments.map((s) => s.id)).toEqual(["legacy-seg-0"]);

    // Le nouvel index unique s'applique bien à une base migrée, pas
    // seulement à une base créée directement en v2.
    await expect(
      store.appendSegment({
        noteId: legacyNote.id,
        seq: 0,
        blob: new Blob(["b"]),
        mimeType: "audio/webm",
        durationMs: 1000,
      }),
    ).rejects.toBeInstanceOf(DuplicateSegmentSeqError);

    await store.close();
  });
});
