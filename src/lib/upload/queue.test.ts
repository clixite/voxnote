import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HEARTBEAT_INTERVAL_MS, STALE_THRESHOLD_MS } from "@/components/activeRecordingMarker";
import { createMemoryNoteStore } from "@/lib/store/memory";
import type { NoteStore } from "@/types/notes";

import { DEFAULT_BASE_DELAY_MS } from "./backoff";
import { ApiRequestError } from "./errors";
import {
  collectQueueItems,
  isSegmentClaimAvailable,
  UploadQueue,
  type QueueSegmentContext,
  type TranscribeSegmentFn,
  type UploadSegmentFn,
} from "./queue";

/** Laisse s'écouler un nombre généreux de tours de micro-tâches, sans dépendre des timers factices. */
async function flushMicrotasks(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

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

/**
 * Store dont l'écriture du statut "error" échoue systématiquement (panne de
 * stockage en écrivant l'échec lui-même — voir B1) ; tout le reste se
 * comporte comme le store en mémoire normal.
 */
function createStoreWithFailingErrorWrite(base: NoteStore): NoteStore {
  return {
    ...base,
    async updateSegment(id, patch) {
      if (patch.status === "error") {
        throw new Error("panne de stockage simulée : écriture du statut d'erreur");
      }
      return base.updateSegment(id, patch);
    },
  };
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

    const items = await collectQueueItems(store, "tab-test");
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

    const items = await collectQueueItems(store, "tab-test");
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

  it("B1 : une écriture du statut d'erreur qui échoue ne doit jamais transformer un échec en boucle serrée", async () => {
    const store = createStoreWithFailingErrorWrite(createMemoryNoteStore());
    const note = await makeProcessingNote(store);
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["audio"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    // Erreur "ambiguous" (ni ApiRequestError ni TypeError réseau) : sans la
    // protection, l'échec de l'écriture du statut "error" ci-dessous laissait
    // `retryState` sans entrée, donc le segment repartait "prêt maintenant"
    // à chaque tick — une boucle microtâche pure, sans le moindre
    // `setTimeout` pour la freiner.
    const uploadSegment: UploadSegmentFn = vi.fn(async () => {
      throw new Error("échec ambigu simulé");
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

    // C'est le COMPTEUR d'appels qui révèle la boucle, pas l'état final :
    // sans le correctif, ce test observait des centaines d'appels en
    // quelques millisecondes de temps réel (voire un worker gelé, la boucle
    // affamant la file de macrotâches). Avec le correctif, le plafond
    // "ambiguous" s'applique à l'identique du cas où l'écriture réussit.
    expect(uploadSegment).toHaveBeenCalledTimes(3); // 1 essai + 2 réessais plafonnés

    // L'écriture du statut a échoué à chaque tentative : le segment reste
    // visible tel qu'avant le dernier échec dans le store (pas de perte de
    // statut fantôme), mais la file, elle, s'est bien arrêtée pour de bon.
    const seg = await firstSegment(store, note.id);
    expect(seg.status).toBe("uploading");
  });

  describe("B2 — réservation de segment par onglet", () => {
    it("deux files sur le même store ne traitent pas le même segment (sonde de la revue)", async () => {
      const store = createMemoryNoteStore();
      const note = await makeProcessingNote(store);
      const segment = await store.appendSegment({
        noteId: note.id,
        seq: 0,
        blob: new Blob(["audio"]),
        mimeType: "audio/webm",
        durationMs: 1000,
      });

      const transcriptions: string[] = [];
      let releaseUploadA: (() => void) | undefined;
      const uploadA: UploadSegmentFn = vi.fn(async (ctx) => {
        await new Promise<void>((resolve) => {
          releaseUploadA = resolve;
        });
        return `https://blob.example/${ctx.noteId}/${ctx.seq}`;
      });
      const transcribeA: TranscribeSegmentFn = vi.fn(async (ctx) => {
        transcriptions.push(`A:${ctx.segmentId}`);
        return { text: "texte A", provider: "groq" };
      });

      const uploadB = immediateUpload();
      const transcribeB: TranscribeSegmentFn = vi.fn(async (ctx) => {
        transcriptions.push(`B:${ctx.segmentId}`);
        return { text: "texte B", provider: "groq" };
      });

      const queueA = new UploadQueue({
        store,
        uploadSegment: uploadA,
        transcribeSegment: transcribeA,
        isOnline: () => true,
        tabId: "tab-a",
      });
      const queueB = new UploadQueue({
        store,
        uploadSegment: uploadB,
        transcribeSegment: transcribeB,
        isOnline: () => true,
        tabId: "tab-b",
      });

      const startA = queueA.start();
      // Laisse A poser sa réservation et entrer dans l'upload (bloqué sur
      // `releaseUploadA`) avant que B ne sonde le store à son tour — c'est
      // le scénario réaliste (un onglet déjà au travail, l'autre sondant
      // plus tard sur son propre minuteur), pas une course de micro-tâches.
      await flushMicrotasks();

      await queueB.start();

      expect(uploadB).not.toHaveBeenCalled();
      expect(transcribeB).not.toHaveBeenCalled();

      releaseUploadA?.();
      await startA;

      // Sonde de la revue : ['A:segId', 'B:segId'] attendu -> une seule entrée.
      expect(transcriptions).toEqual([`A:${segment.id}`]);
      const seg = await firstSegment(store, note.id);
      expect(seg.status).toBe("done");
    });

    it("une réservation périmée est reprise : un onglet mort ne bloque jamais un segment pour de bon", async () => {
      const store = createMemoryNoteStore();
      const note = await makeProcessingNote(store);
      const segment = await store.appendSegment({
        noteId: note.id,
        seq: 0,
        blob: new Blob(["audio"]),
        mimeType: "audio/webm",
        durationMs: 1000,
      });
      // Réservation laissée par un onglet mort avant la fin de l'upload,
      // horodatée très loin dans le passé : périmée quel que soit l'instant
      // présent du test.
      await store.updateSegment(segment.id, {
        status: "uploading",
        claimedBy: "tab-dead",
        claimedAt: 0,
      });

      const uploadSegment = immediateUpload();
      const transcribeSegment = immediateTranscribe();
      const queue = new UploadQueue({
        store,
        uploadSegment,
        transcribeSegment,
        isOnline: () => true,
        tabId: "tab-alive",
      });
      await queue.start();

      expect(uploadSegment).toHaveBeenCalledTimes(1);
      const seg = await firstSegment(store, note.id);
      expect(seg.status).toBe("done");
    });

    it("une réservation fraîche d'un autre onglet est ignorée", async () => {
      const store = createMemoryNoteStore();
      const note = await makeProcessingNote(store);
      const segment = await store.appendSegment({
        noteId: note.id,
        seq: 0,
        blob: new Blob(["audio"]),
        mimeType: "audio/webm",
        durationMs: 1000,
      });
      await store.updateSegment(segment.id, {
        status: "uploading",
        claimedBy: "tab-other",
        claimedAt: Date.now(),
      });

      const uploadSegment = immediateUpload();
      const transcribeSegment = immediateTranscribe();
      const queue = new UploadQueue({
        store,
        uploadSegment,
        transcribeSegment,
        isOnline: () => true,
        tabId: "tab-me",
      });
      await queue.start();

      expect(uploadSegment).not.toHaveBeenCalled();
      const seg = await firstSegment(store, note.id);
      expect(seg.status).toBe("uploading");
      expect(seg.claimedBy).toBe("tab-other");
    });

    it("la réservation est libérée après un échec : le segment reste reprenable, même par un autre onglet, sans attendre le backoff du premier", async () => {
      const store = createMemoryNoteStore();
      const note = await makeProcessingNote(store);
      await store.appendSegment({
        noteId: note.id,
        seq: 0,
        blob: new Blob(["audio"]),
        mimeType: "audio/webm",
        durationMs: 1000,
      });

      const failingUpload: UploadSegmentFn = vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      });
      const queueA = new UploadQueue({
        store,
        uploadSegment: failingUpload,
        transcribeSegment: immediateTranscribe(),
        isOnline: () => true,
        tabId: "tab-a",
      });
      await queueA.start();

      let seg = await firstSegment(store, note.id);
      expect(seg.status).toBe("error");
      expect(seg.claimedBy).toBeUndefined();
      expect(seg.claimedAt).toBeUndefined();

      // tab-b n'a aucune idée du backoff en mémoire de tab-a : la
      // réservation libérée suffit à lui permettre de reprendre tout de
      // suite, plutôt que de laisser le segment bloqué en attendant tab-a.
      const uploadB = immediateUpload();
      const queueB = new UploadQueue({
        store,
        uploadSegment: uploadB,
        transcribeSegment: immediateTranscribe(),
        isOnline: () => true,
        tabId: "tab-b",
      });
      await queueB.start();

      expect(uploadB).toHaveBeenCalledTimes(1);
      seg = await firstSegment(store, note.id);
      expect(seg.status).toBe("done");
    });

    it("la réservation est rafraîchie pendant un traitement réellement en cours, jamais vue comme périmée par un autre onglet", async () => {
      const store = createMemoryNoteStore();
      const note = await makeProcessingNote(store);
      await store.appendSegment({
        noteId: note.id,
        seq: 0,
        blob: new Blob(["audio"]),
        mimeType: "audio/webm",
        durationMs: 1000,
      });

      let releaseUpload: (() => void) | undefined;
      const slowUpload: UploadSegmentFn = vi.fn(async (ctx) => {
        await new Promise<void>((resolve) => {
          releaseUpload = resolve;
        });
        return `https://blob.example/${ctx.noteId}/${ctx.seq}`;
      });
      const queueA = new UploadQueue({
        store,
        uploadSegment: slowUpload,
        transcribeSegment: immediateTranscribe(),
        isOnline: () => true,
        tabId: "tab-a",
      });

      const startA = queueA.start();
      await flushMicrotasks(); // A a réservé le segment et est bloqué dans l'upload

      // Le traitement dure plus longtemps que le seuil de péremption : sans
      // rafraîchissement de `claimedAt`, un autre onglet le croirait
      // abandonné et se remettrait à le traiter en double.
      expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(STALE_THRESHOLD_MS);
      await vi.advanceTimersByTimeAsync(STALE_THRESHOLD_MS + 1000);

      const uploadB = immediateUpload();
      const queueB = new UploadQueue({
        store,
        uploadSegment: uploadB,
        transcribeSegment: immediateTranscribe(),
        isOnline: () => true,
        tabId: "tab-b",
      });
      await queueB.start();

      expect(uploadB).not.toHaveBeenCalled();

      releaseUpload?.();
      await startA;

      const seg = await firstSegment(store, note.id);
      expect(seg.status).toBe("done");
    });
  });
});

describe("isSegmentClaimAvailable", () => {
  const NOW = 1_000_000;

  it("libre si jamais réservé", () => {
    expect(isSegmentClaimAvailable({ claimedBy: undefined, claimedAt: undefined }, "tab-a", NOW)).toBe(
      true,
    );
  });

  it("toujours disponible pour l'onglet qui détient déjà la réservation", () => {
    expect(isSegmentClaimAvailable({ claimedBy: "tab-a", claimedAt: NOW - 1 }, "tab-a", NOW)).toBe(true);
  });

  it("indisponible pour un autre onglet tant que la réservation est fraîche", () => {
    expect(
      isSegmentClaimAvailable(
        { claimedBy: "tab-a", claimedAt: NOW },
        "tab-b",
        NOW + STALE_THRESHOLD_MS - 1,
      ),
    ).toBe(false);
  });

  it("redevient disponible pour un autre onglet une fois périmée", () => {
    expect(
      isSegmentClaimAvailable(
        { claimedBy: "tab-a", claimedAt: NOW },
        "tab-b",
        NOW + STALE_THRESHOLD_MS + 1,
      ),
    ).toBe(true);
  });
});
