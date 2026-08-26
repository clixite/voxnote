/**
 * Batterie d'assertions commune aux deux implémentations de `NoteStore`.
 * Objectif : garantir qu'elles ne divergent jamais dans leur comportement
 * observable (tris, atomicité, erreurs) — voir CLAUDE.md et le ticket P2-1.
 */
import { describe, expect, it } from "vitest";

import type { NoteStore } from "@/types/notes";

import { createIndexedDbNoteStore } from "./indexeddb";
import {
  DuplicateSegmentSeqError,
  NoteNotFoundError,
  SegmentNotFoundError,
} from "./errors";
import { createMemoryNoteStore } from "./memory";

import "./test-fake-idb";

let dbCounter = 0;

const implementations: Array<[string, () => NoteStore]> = [
  ["memory", () => createMemoryNoteStore()],
  [
    "indexeddb",
    () => {
      dbCounter += 1;
      return createIndexedDbNoteStore({ dbName: `contract-${dbCounter}` });
    },
  ],
];

describe.each(implementations)("NoteStore — %s", (_name, createStore) => {
  it("crée une note et la relit", async () => {
    const store = createStore();
    const note = await store.createNote({ lang: "fr" });

    expect(note.id).toBeTruthy();
    expect(note.status).toBe("recording");
    expect(note.durationMs).toBe(0);

    const found = await store.getNote(note.id);
    expect(found).toEqual(note);
  });

  it("liste les notes en ordre antéchronologique", async () => {
    const store = createStore();
    const first = await store.createNote({ lang: "fr" });
    const second = await store.createNote({ lang: "en", title: "Réunion" });
    const third = await store.createNote({ lang: "auto" });

    // Force un ordre de création sans ambiguïté même si l'horloge est rapide.
    await store.updateNote(first.id, { createdAt: 1 });
    await store.updateNote(second.id, { createdAt: 2 });
    await store.updateNote(third.id, { createdAt: 3 });

    const notes = await store.listNotes();
    expect(notes.map((n) => n.id)).toEqual([third.id, second.id, first.id]);
  });

  it("updateNote fusionne le patch et conserve l'id", async () => {
    const store = createStore();
    const note = await store.createNote({ lang: "fr" });
    const updated = await store.updateNote(note.id, {
      text: "Bonjour",
      textEdited: true,
      status: "done",
    });

    expect(updated.id).toBe(note.id);
    expect(updated.text).toBe("Bonjour");
    expect(updated.textEdited).toBe(true);
    expect(updated.status).toBe("done");
    expect(updated.lang).toBe("fr");
  });

  it("updateNote met à jour updatedAt à l'heure courante par défaut", async () => {
    const store = createStore();
    const note = await store.createNote({ lang: "fr" });
    await store.updateNote(note.id, { createdAt: 1000 }); // isole du createdAt

    const before = Date.now();
    const updated = await store.updateNote(note.id, { status: "done" });
    const after = Date.now();

    expect(updated.updatedAt).toBeGreaterThanOrEqual(before);
    expect(updated.updatedAt).toBeLessThanOrEqual(after);
  });

  it("updateNote respecte un updatedAt fixé explicitement par le patch", async () => {
    const store = createStore();
    const note = await store.createNote({ lang: "fr" });

    const updated = await store.updateNote(note.id, { updatedAt: 42 });
    expect(updated.updatedAt).toBe(42);
  });

  it("updateNote sur une note inexistante lève NoteNotFoundError", async () => {
    const store = createStore();
    await expect(
      store.updateNote("absente", { status: "done" }),
    ).rejects.toBeInstanceOf(NoteNotFoundError);
  });

  it("getNote sur une note inexistante résout undefined", async () => {
    const store = createStore();
    await expect(store.getNote("absente")).resolves.toBeUndefined();
  });

  it("deleteNote sur une note inexistante ne lève pas", async () => {
    const store = createStore();
    await expect(store.deleteNote("absente")).resolves.toBeUndefined();
  });

  it("appendSegment sur une note inexistante lève NoteNotFoundError", async () => {
    const store = createStore();
    await expect(
      store.appendSegment({
        noteId: "absente",
        seq: 0,
        blob: new Blob(["x"]),
        mimeType: "audio/webm",
        durationMs: 1000,
      }),
    ).rejects.toBeInstanceOf(NoteNotFoundError);
  });

  it("updateSegment sur un segment inexistant lève SegmentNotFoundError", async () => {
    const store = createStore();
    await expect(
      store.updateSegment("absent", { status: "uploaded" }),
    ).rejects.toBeInstanceOf(SegmentNotFoundError);
  });

  it("listSegments trie par seq même si les segments arrivent dans le désordre", async () => {
    const store = createStore();
    const note = await store.createNote({ lang: "fr" });

    for (const seq of [2, 0, 1]) {
      await store.appendSegment({
        noteId: note.id,
        seq,
        blob: new Blob([`segment-${seq}`]),
        mimeType: "audio/webm",
        durationMs: 1000,
      });
    }

    const segments = await store.listSegments(note.id);
    expect(segments.map((s) => s.seq)).toEqual([0, 1, 2]);
  });

  it("appendSegment refuse un doublon de seq pour la même note", async () => {
    const store = createStore();
    const note = await store.createNote({ lang: "fr" });

    const first = await store.appendSegment({
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
        blob: new Blob(["deuxieme"]),
        mimeType: "audio/webm",
        durationMs: 1000,
      }),
    ).rejects.toBeInstanceOf(DuplicateSegmentSeqError);

    // Le doublon rejeté ne doit pas avoir remplacé ni ajouté quoi que ce soit.
    const segments = await store.listSegments(note.id);
    expect(segments.map((s) => s.id)).toEqual([first.id]);
  });

  it("appendSegment autorise le même seq sur deux notes différentes", async () => {
    const store = createStore();
    const noteA = await store.createNote({ lang: "fr" });
    const noteB = await store.createNote({ lang: "en" });

    await store.appendSegment({
      noteId: noteA.id,
      seq: 0,
      blob: new Blob(["a"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });
    await expect(
      store.appendSegment({
        noteId: noteB.id,
        seq: 0,
        blob: new Blob(["b"]),
        mimeType: "audio/webm",
        durationMs: 1000,
      }),
    ).resolves.toBeDefined();
  });

  it("listSegments d'une note inexistante renvoie une liste vide", async () => {
    const store = createStore();
    await expect(store.listSegments("absente")).resolves.toEqual([]);
  });

  it("cycle complet : note + 3 segments relus dans l'ordre", async () => {
    const store = createStore();
    const note = await store.createNote({ lang: "fr" });
    for (let seq = 0; seq < 3; seq += 1) {
      await store.appendSegment({
        noteId: note.id,
        seq,
        blob: new Blob([`s${seq}`]),
        mimeType: "audio/webm",
        durationMs: 60_000,
      });
    }

    const segments = await store.listSegments(note.id);
    expect(segments).toHaveLength(3);
    expect(segments.every((s) => s.noteId === note.id)).toBe(true);
    expect(segments.map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(segments.every((s) => s.status === "local")).toBe(true);
  });

  it("updateSegment fusionne le patch sans toucher id/noteId/seq", async () => {
    const store = createStore();
    const note = await store.createNote({ lang: "fr" });
    const segment = await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["x"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    const updated = await store.updateSegment(segment.id, {
      status: "uploaded",
      blobUrl: "https://blob.example/x",
      attempts: 1,
    });

    expect(updated.id).toBe(segment.id);
    expect(updated.noteId).toBe(note.id);
    expect(updated.seq).toBe(0);
    expect(updated.status).toBe("uploaded");
    expect(updated.blobUrl).toBe("https://blob.example/x");
    expect(updated.attempts).toBe(1);
  });

  it("listPendingSegments ne renvoie que ce qui reste à uploader, par ancienneté", async () => {
    const store = createStore();
    const noteA = await store.createNote({ lang: "fr" });
    const noteB = await store.createNote({ lang: "en" });

    const a0 = await store.appendSegment({
      noteId: noteA.id,
      seq: 0,
      blob: new Blob(["a0"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });
    const b0 = await store.appendSegment({
      noteId: noteB.id,
      seq: 0,
      blob: new Blob(["b0"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });
    const a1 = await store.appendSegment({
      noteId: noteA.id,
      seq: 1,
      blob: new Blob(["a1"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    // a0 est déjà passé côté Blob : ne doit plus apparaître comme "à uploader".
    await store.updateSegment(a0.id, { status: "done" });
    // b0 est reparti en erreur : reste à uploader (retry).
    await store.updateSegment(b0.id, { status: "error", error: "réseau" });

    const pending = await store.listPendingSegments();
    expect(pending.map((s) => s.id)).toEqual([b0.id, a1.id]);
  });

  it("deleteNote supprime la note, ses segments et ses transcripts", async () => {
    const store = createStore();
    const note = await store.createNote({ lang: "fr" });
    const segment = await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["x"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });
    await store.putTranscript({
      noteId: note.id,
      seq: 0,
      text: "Bonjour",
      provider: "groq",
      createdAt: Date.now(),
    });

    await store.deleteNote(note.id);

    await expect(store.getNote(note.id)).resolves.toBeUndefined();
    await expect(store.listSegments(note.id)).resolves.toEqual([]);
    await expect(store.listTranscripts(note.id)).resolves.toEqual([]);
    // Le segment supprimé ne doit pas non plus traîner dans la queue d'upload.
    const pending = await store.listPendingSegments();
    expect(pending.find((s) => s.id === segment.id)).toBeUndefined();
  });

  it("un Blob relu est bien un Blob de même taille et même type", async () => {
    const store = createStore();
    const note = await store.createNote({ lang: "fr" });
    const original = new Blob(["contenu audio de test"], {
      type: "audio/webm;codecs=opus",
    });

    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: original,
      mimeType: "audio/webm;codecs=opus",
      durationMs: 1000,
    });

    const segments = await store.listSegments(note.id);
    expect(segments).toHaveLength(1);
    const segment = segments[0]!;
    expect(segment.blob).toBeInstanceOf(Blob);
    expect(segment.blob.size).toBe(original.size);
    expect(segment.blob.type).toBe(original.type);
  });

  it("putTranscript / listTranscripts", async () => {
    const store = createStore();
    const note = await store.createNote({ lang: "fr" });

    await store.putTranscript({
      noteId: note.id,
      seq: 1,
      text: "deuxième",
      provider: "groq",
      createdAt: 2,
    });
    await store.putTranscript({
      noteId: note.id,
      seq: 0,
      text: "première",
      provider: "groq",
      createdAt: 1,
    });

    const transcripts = await store.listTranscripts(note.id);
    expect(transcripts.map((t) => t.text)).toEqual(["première", "deuxième"]);
  });

  it("claimSegment sur un segment inexistant renvoie false", async () => {
    const store = createStore();
    await expect(store.claimSegment("absent", "tab-a", 0)).resolves.toBe(
      false,
    );
  });

  it("claimSegment réserve un segment libre", async () => {
    const store = createStore();
    const note = await store.createNote({ lang: "fr" });
    const segment = await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["x"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    await expect(
      store.claimSegment(segment.id, "tab-a", Date.now()),
    ).resolves.toBe(true);
  });

  it("claimSegment est idempotent pour l'onglet qui possède déjà la réservation", async () => {
    const store = createStore();
    const note = await store.createNote({ lang: "fr" });
    const segment = await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["x"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    await store.claimSegment(segment.id, "tab-a", Date.now());
    await expect(
      store.claimSegment(segment.id, "tab-a", Date.now()),
    ).resolves.toBe(true);
  });

  // Lit le `claimedAt` réellement persisté plutôt que d'utiliser l'horodatage
  // capturé côté test : l'implémentation pose le sien via son propre
  // `Date.now()`, après un aller-retour asynchrone (voire une vraie
  // transaction IndexedDB) — s'y fier à ±1ms près serait un test flaky.
  async function claimedAtOf(
    store: NoteStore,
    noteId: string,
    segmentId: string,
  ): Promise<number> {
    const segments = await store.listSegments(noteId);
    const segment = segments.find((s) => s.id === segmentId);
    return segment!.claimedAt!;
  }

  it("claimSegment refuse une réservation fraîche d'un autre onglet", async () => {
    const store = createStore();
    const note = await store.createNote({ lang: "fr" });
    const segment = await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["x"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    await store.claimSegment(segment.id, "tab-a", Date.now());
    const claimedAt = await claimedAtOf(store, note.id, segment.id);

    // staleBefore == claimedAt : pas strictement antérieur, donc pas périmée.
    await expect(
      store.claimSegment(segment.id, "tab-b", claimedAt),
    ).resolves.toBe(false);
  });

  it("claimSegment reprend une réservation périmée pour un autre onglet", async () => {
    const store = createStore();
    const note = await store.createNote({ lang: "fr" });
    const segment = await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["x"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    await store.claimSegment(segment.id, "tab-a", Date.now());
    const claimedAt = await claimedAtOf(store, note.id, segment.id);

    // staleBefore strictement postérieur à claimedAt : la réservation de
    // tab-a est périmée.
    await expect(
      store.claimSegment(segment.id, "tab-b", claimedAt + 1),
    ).resolves.toBe(true);
  });

  it("releaseSegment par le mauvais onglet ne libère rien", async () => {
    const store = createStore();
    const note = await store.createNote({ lang: "fr" });
    const segment = await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["x"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    await store.claimSegment(segment.id, "tab-a", Date.now());
    const claimedAt = await claimedAtOf(store, note.id, segment.id);
    await store.releaseSegment(segment.id, "tab-b");

    // Toujours réservé par tab-a : une réservation fraîche d'un autre onglet
    // reste refusée après la tentative de libération illégitime.
    await expect(
      store.claimSegment(segment.id, "tab-b", claimedAt),
    ).resolves.toBe(false);
  });

  it("releaseSegment par le bon onglet libère la réservation immédiatement", async () => {
    const store = createStore();
    const note = await store.createNote({ lang: "fr" });
    const segment = await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["x"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    await store.claimSegment(segment.id, "tab-a", Date.now());
    await store.releaseSegment(segment.id, "tab-a");

    // Libre : même un staleBefore à 0 (donc "aucune réservation n'est
    // périmée") ne doit pas bloquer, puisqu'il n'y a plus de réservation
    // du tout — « libre » l'emporte sur « périmée ».
    await expect(store.claimSegment(segment.id, "tab-b", 0)).resolves.toBe(
      true,
    );
  });

  it("deux claimSegment concurrents sur le même segment : une seule réservation aboutit", async () => {
    const store = createStore();
    const note = await store.createNote({ lang: "fr" });
    const segment = await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["x"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    // Aucun `await` entre les deux appels : sur l'implémentation IndexedDB,
    // les deux transactions s'ouvrent réellement en parallèle — c'est
    // exactement le scénario de l'événement `online` délivré simultanément à
    // tous les onglets qui a produit six transcriptions pour trois segments.
    const [claimA, claimB] = await Promise.all([
      store.claimSegment(segment.id, "tab-a", Date.now()),
      store.claimSegment(segment.id, "tab-b", Date.now()),
    ]);

    expect([claimA, claimB].filter(Boolean)).toHaveLength(1);
  });
});
