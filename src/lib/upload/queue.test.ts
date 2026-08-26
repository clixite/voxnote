import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryNoteStore } from "@/lib/store/memory";
import type { NoteStore } from "@/types/notes";

import { DEFAULT_BASE_DELAY_MS } from "./backoff";
import { ApiRequestError } from "./errors";
import {
  collectQueueItems,
  UploadQueue,
  type QueueSegmentContext,
  type TranscribeSegmentFn,
  type UploadSegmentFn,
} from "./queue";

async function firstSegment(store: NoteStore, noteId: string) {
  const segments = await store.listSegments(noteId);
  const segment = segments[0];
  if (!segment) throw new Error("segment attendu introuvable dans le store de test");
  return segment;
}

async function makeProcessingNote(store: NoteStore) {
  const note = await store.createNote({ lang: "fr" });
  // La file ne touche jamais une note encore "recording" (voir queue.ts) :
  // les tests simulent un enregistrement déjà arrêté, comme le ferait
  // RecorderScreen à la fin d'une session.
  await store.updateNote(note.id, { status: "processing" });
  return note;
}

function immediateUpload(prefix = "https://blob.example"): UploadSegmentFn {
  return vi.fn(async (ctx: QueueSegmentContext) => `${prefix}/${ctx.noteId}/${ctx.seq}`);
}

function immediateTranscribe(textFor: (ctx: QueueSegmentContext) => string = (ctx) => `texte ${ctx.seq}`): TranscribeSegmentFn {
  return vi.fn(async (ctx) => ({ text: textFor(ctx), provider: "groq" }));
}

describe("collectQueueItems", () => {
  it("reprend les segments error/local/uploading (listPendingSegments) ET les uploaded/transcribing", async () => {
    const store = createMemoryNoteStore();
    const note = await makeProcessingNote(store);
    const local = await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["a"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });
    const uploaded = await store.appendSegment({
      noteId: note.id,
      seq: 1,
      blob: new Blob(["b"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });
    await store.updateSegment(uploaded.id, {
      status: "uploaded",
      blobUrl: "https://blob.example/x/1",
    });
    const done = await store.appendSegment({
      noteId: note.id,
      seq: 2,
      blob: new Blob(["c"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });
    await store.updateSegment(done.id, { status: "done" });

    const items = await collectQueueItems(store);
    const ids = items.map((i) => i.segmentId).sort();
    expect(ids).toEqual([local.id, uploaded.id].sort());
    const uploadedItem = items.find((i) => i.segmentId === uploaded.id);
    expect(uploadedItem?.blobUrl).toBe("https://blob.example/x/1");
    expect(uploadedItem?.lang).toBe("fr");
  });

  it("ignore un segment dont la note a été supprimée entre-temps", async () => {
    const store = createMemoryNoteStore();
    const note = await makeProcessingNote(store);
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["a"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });
    await store.deleteNote(note.id);

    const items = await collectQueueItems(store);
    expect(items).toEqual([]);
  });
});

describe("UploadQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("chaîne complète d'un segment : local -> uploading -> uploaded -> transcribing -> done, transcript persisté", async () => {
    const store = createMemoryNoteStore();
    const note = await makeProcessingNote(store);
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["audio"]),
      mimeType: "audio/webm",
      durationMs: 5000,
    });

    const uploadSegment = immediateUpload();
    const transcribeSegment = immediateTranscribe(() => "Bonjour tout le monde.");

    const queue = new UploadQueue({ store, uploadSegment, transcribeSegment, isOnline: () => true });
    await queue.start();

    const updated = await store.getNote(note.id).then((n) => n!);
    const seg = await firstSegment(store, note.id);

    expect(seg.status).toBe("done");
    expect(seg.blobUrl).toBe(`https://blob.example/${note.id}/0`);
    expect(seg.attempts).toBe(1);
    expect(seg.error).toBeUndefined();

    const transcripts = await store.listTranscripts(note.id);
    expect(transcripts).toEqual([
      expect.objectContaining({ noteId: note.id, seq: 0, text: "Bonjour tout le monde.", provider: "groq" }),
    ]);

    expect(updated.status).toBe("done");
    expect(updated.text).toBe("Bonjour tout le monde.");
    expect(uploadSegment).toHaveBeenCalledTimes(1);
    expect(transcribeSegment).toHaveBeenCalledTimes(1);
  });

  it("ne touche jamais le statut d'une note encore en cours d'enregistrement", async () => {
    const store = createMemoryNoteStore();
    const note = await store.createNote({ lang: "fr" }); // status "recording", jamais basculée en "processing" ici
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["audio"]),
      mimeType: "audio/webm",
      durationMs: 5000,
    });

    const queue = new UploadQueue({
      store,
      uploadSegment: immediateUpload(),
      transcribeSegment: immediateTranscribe(),
      isOnline: () => true,
    });
    await queue.start();

    const seg = await firstSegment(store, note.id);
    expect(seg.status).toBe("done"); // le segment, lui, progresse normalement

    const stillRecording = await store.getNote(note.id).then((n) => n!);
    expect(stillRecording.status).toBe("recording"); // la note, non : ce n'est pas à la file de décider
    expect(stillRecording.text).toBeUndefined();
  });

  it("échec réseau (retryable) puis reprise réussie, avec backoff", async () => {
    const store = createMemoryNoteStore();
    const note = await makeProcessingNote(store);
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["audio"]),
      mimeType: "audio/webm",
      durationMs: 5000,
    });

    let call = 0;
    const uploadSegment: UploadSegmentFn = vi.fn(async (ctx) => {
      call += 1;
      if (call === 1) throw new TypeError("Failed to fetch");
      return `https://blob.example/${ctx.noteId}/${ctx.seq}`;
    });
    const transcribeSegment = immediateTranscribe();

    const queue = new UploadQueue({ store, uploadSegment, transcribeSegment, isOnline: () => true });
    await queue.start();

    let seg = await firstSegment(store, note.id);
    expect(seg.status).toBe("error");
    expect(seg.error).toMatch(/connexion/i);
    expect(uploadSegment).toHaveBeenCalledTimes(1);

    // Rien ne se passe avant l'expiration du backoff : pas de nouvelle tentative précoce.
    await vi.advanceTimersByTimeAsync(DEFAULT_BASE_DELAY_MS - 100);
    expect(uploadSegment).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200);

    seg = await firstSegment(store, note.id);
    expect(seg.status).toBe("done");
    expect(uploadSegment).toHaveBeenCalledTimes(2);
    expect(seg.attempts).toBe(2);
  });

  it("erreur retryable: false → arrêt immédiat, aucun réessai même après une longue attente", async () => {
    const store = createMemoryNoteStore();
    const note = await makeProcessingNote(store);
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["audio"]),
      mimeType: "audio/webm",
      durationMs: 5000,
    });

    const uploadSegment = immediateUpload();
    const transcribeSegment: TranscribeSegmentFn = vi.fn(async () => {
      throw new ApiRequestError({
        error: "AUDIO_UNREADABLE",
        message: "Ce passage audio est illisible.",
        retryable: false,
      });
    });

    const queue = new UploadQueue({ store, uploadSegment, transcribeSegment, isOnline: () => true });
    await queue.start();

    const seg = await firstSegment(store, note.id);
    expect(seg.status).toBe("error");
    expect(seg.error).toBe("Ce passage audio est illisible.");
    expect(transcribeSegment).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(transcribeSegment).toHaveBeenCalledTimes(1);

    const note2 = await store.getNote(note.id).then((n) => n!);
    expect(note2.status).toBe("error");
  });

  it("segment déjà uploadé qui échoue à la transcription n'est jamais ré-uploadé", async () => {
    const store = createMemoryNoteStore();
    const note = await makeProcessingNote(store);
    const seg0 = await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["audio"]),
      mimeType: "audio/webm",
      durationMs: 5000,
    });
    await store.updateSegment(seg0.id, {
      status: "uploaded",
      blobUrl: "https://blob.example/deja-la/0",
    });

    const uploadSegment = immediateUpload();
    let transcribeCalls = 0;
    const transcribeSegment: TranscribeSegmentFn = vi.fn(async () => {
      transcribeCalls += 1;
      if (transcribeCalls === 1) throw new TypeError("Failed to fetch");
      return { text: "reprise réussie", provider: "groq" };
    });

    const queue = new UploadQueue({ store, uploadSegment, transcribeSegment, isOnline: () => true });
    await queue.start();
    await vi.advanceTimersByTimeAsync(DEFAULT_BASE_DELAY_MS + 500);

    const seg = await firstSegment(store, note.id);
    expect(seg.status).toBe("done");
    expect(seg.blobUrl).toBe("https://blob.example/deja-la/0");
    expect(uploadSegment).not.toHaveBeenCalled();
    expect(transcribeSegment).toHaveBeenCalledTimes(2);
  });

  it("reprise après refresh : une nouvelle file reconstruit tout depuis le NoteStore", async () => {
    const store = createMemoryNoteStore();
    const note = await makeProcessingNote(store);
    // Segment laissé "uploading" par un onglet mort avant la fin de l'upload
    // (voir pending.ts) : aucun blobUrl, doit reprendre l'upload depuis zéro.
    const interrupted = await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["audio"]),
      mimeType: "audio/webm",
      durationMs: 5000,
    });
    await store.updateSegment(interrupted.id, { status: "uploading" });

    // Une première "session" (jamais démarrée) n'a donc rien pu faire : on
    // simule directement le refresh en créant une queue toute neuve.
    const uploadSegment = immediateUpload();
    const transcribeSegment = immediateTranscribe();
    const queue = new UploadQueue({ store, uploadSegment, transcribeSegment, isOnline: () => true });
    await queue.start();

    const seg = await firstSegment(store, note.id);
    expect(seg.status).toBe("done");
    expect(uploadSegment).toHaveBeenCalledTimes(1);
  });

  it("concurrence bornée : jamais plus de `concurrency` segments en vol simultanément", async () => {
    const store = createMemoryNoteStore();
    const note = await makeProcessingNote(store);
    for (let seq = 0; seq < 5; seq += 1) {
      await store.appendSegment({
        noteId: note.id,
        seq,
        blob: new Blob([`audio-${seq}`]),
        mimeType: "audio/webm",
        durationMs: 1000,
      });
    }

    let active = 0;
    let maxActive = 0;
    const uploadSegment: UploadSegmentFn = vi.fn(async (ctx) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      await Promise.resolve();
      active -= 1;
      return `https://blob.example/${ctx.noteId}/${ctx.seq}`;
    });
    const transcribeSegment = immediateTranscribe();

    const queue = new UploadQueue({
      store,
      uploadSegment,
      transcribeSegment,
      concurrency: 2,
      isOnline: () => true,
    });
    await queue.start();

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(1); // preuve qu'il y a bien eu du parallélisme, pas juste du séquentiel
    expect(uploadSegment).toHaveBeenCalledTimes(5);

    const segments = await store.listSegments(note.id);
    expect(segments.every((s) => s.status === "done")).toBe(true);
  });

  it("assemble le transcript par seq, même si les réponses de transcription arrivent dans le désordre", async () => {
    const store = createMemoryNoteStore();
    const note = await makeProcessingNote(store);
    for (let seq = 0; seq < 3; seq += 1) {
      await store.appendSegment({
        noteId: note.id,
        seq,
        blob: new Blob([`audio-${seq}`]),
        mimeType: "audio/webm",
        durationMs: 1000,
      });
    }

    const uploadSegment = immediateUpload();
    // Le segment 2 répond avant le 0 et le 1 : l'assemblage ne doit pas s'en soucier.
    const delayBySeq = [30, 20, 5];
    const transcribeSegment: TranscribeSegmentFn = vi.fn(async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, delayBySeq[ctx.seq]));
      return { text: `Segment ${ctx.seq}.`, provider: "groq" };
    });

    const queue = new UploadQueue({
      store,
      uploadSegment,
      transcribeSegment,
      concurrency: 3,
      isOnline: () => true,
    });
    const started = queue.start();
    await vi.advanceTimersByTimeAsync(50);
    await started;

    const finalNote = await store.getNote(note.id).then((n) => n!);
    expect(finalNote.text).toBe("Segment 0.\n\nSegment 1.\n\nSegment 2.");
    expect(finalNote.status).toBe("done");
  });

  it("hors-ligne : ne tente rien, mais le nombre de segments en attente reste visible", async () => {
    const store = createMemoryNoteStore();
    const note = await makeProcessingNote(store);
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["audio"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    const uploadSegment = immediateUpload();
    const transcribeSegment = immediateTranscribe();
    const queue = new UploadQueue({ store, uploadSegment, transcribeSegment, isOnline: () => false });
    await queue.start();

    expect(uploadSegment).not.toHaveBeenCalled();
    expect(queue.getSnapshot().globalStatus).toBe("offline");
    expect(queue.getSnapshot().pendingCount).toBe(1);

    const seg = await firstSegment(store, note.id);
    expect(seg.status).toBe("local");
  });

  it("erreur ambiguë : réessayée un nombre plafonné de fois puis arrêtée, jamais indéfiniment", async () => {
    const store = createMemoryNoteStore();
    const note = await makeProcessingNote(store);
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["audio"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    // Ni ApiRequestError ni TypeError réseau : lacune de contrat (voir errors.ts),
    // classée "ambiguous" — réessayée, mais pas indéfiniment.
    const uploadSegment: UploadSegmentFn = vi.fn(async () => {
      throw new Error("Failed to retrieve the client token");
    });
    const transcribeSegment = immediateTranscribe();

    const queue = new UploadQueue({
      store,
      uploadSegment,
      transcribeSegment,
      isOnline: () => true,
      maxAmbiguousAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 40,
    });
    await queue.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(uploadSegment).toHaveBeenCalledTimes(3); // 1 essai + 2 réessais plafonnés
    const seg = await firstSegment(store, note.id);
    expect(seg.status).toBe("error");
    expect(seg.error).toMatch(/Réessayer/);

    // Un réessai manuel redonne un budget frais et retente immédiatement.
    await queue.retrySegment(seg.id);
    expect(uploadSegment).toHaveBeenCalledTimes(4);
  });
});
