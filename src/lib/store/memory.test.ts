/**
 * Tests spécifiques au double en mémoire : prouve que `deleteNote` reste
 * observablement atomique même quand une étape échoue en cours de route, à
 * la parité de la garantie transactionnelle de `indexeddb.ts` (voir le
 * commentaire « atomiquement » sur `NoteStore.deleteNote`).
 *
 * Sans ce test, l'atomicité de `memory.ts` tenait uniquement au fait qu'une
 * `Map` ne peut pas échouer en pratique — vrai aujourd'hui, mais rien
 * n'empêcherait une évolution future d'y introduire une étape faillible sans
 * que rien ne le remarque. `failDeleteNoteAt` simule cette panne.
 */
import { describe, expect, it } from "vitest";

import { createMemoryNoteStore } from "./memory";

describe("createMemoryNoteStore — atomicité de deleteNote", () => {
  it("restaure la note et ses segments si la suppression des segments échoue", async () => {
    const store = createMemoryNoteStore({ failDeleteNoteAt: "segments" });
    const note = await store.createNote({ lang: "fr" });
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["x"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    await expect(store.deleteNote(note.id)).rejects.toThrow();

    // Rien n'a dû disparaître : ni la note, ni son segment. Une suppression
    // à moitié faite laisserait un audio orphelin (manquement RGPD).
    await expect(store.getNote(note.id)).resolves.toEqual(note);
    const segments = await store.listSegments(note.id);
    expect(segments).toHaveLength(1);
  });

  it("restaure la note et ses transcripts si la suppression des transcripts échoue", async () => {
    const store = createMemoryNoteStore({ failDeleteNoteAt: "transcripts" });
    const note = await store.createNote({ lang: "fr" });
    await store.putTranscript({
      noteId: note.id,
      seq: 0,
      text: "Bonjour",
      provider: "groq",
      createdAt: Date.now(),
    });

    await expect(store.deleteNote(note.id)).rejects.toThrow();

    await expect(store.getNote(note.id)).resolves.toEqual(note);
    const transcripts = await store.listTranscripts(note.id);
    expect(transcripts).toHaveLength(1);
  });

  it("sans panne simulée, deleteNote supprime tout normalement", async () => {
    const store = createMemoryNoteStore();
    const note = await store.createNote({ lang: "fr" });
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["x"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    await expect(store.deleteNote(note.id)).resolves.toBeUndefined();
    await expect(store.getNote(note.id)).resolves.toBeUndefined();
    await expect(store.listSegments(note.id)).resolves.toEqual([]);
  });
});
