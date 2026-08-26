import { RECORDER_SEGMENT_MS } from "@/types/notes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InvalidRecorderTransitionError } from "./machine";
import { RecorderEngine, type RecorderEngineOptions } from "./engine";
import {
  createFakeMediaStream,
  createFakeNoteStore,
  FakeMediaRecorder,
} from "./test-utils";

async function setup(overrides: Partial<RecorderEngineOptions> = {}) {
  const store = createFakeNoteStore();
  const stream = createFakeMediaStream();
  const note = await store.createNote({ lang: "fr" });
  FakeMediaRecorder.supportedTypes = new Set(["audio/webm;codecs=opus"]);

  const engine = new RecorderEngine({
    store,
    noteId: note.id,
    stream,
    createMediaRecorder: (s, o) => new FakeMediaRecorder(s, o) as unknown as MediaRecorder,
    isTypeSupported: (t) => FakeMediaRecorder.isTypeSupported(t),
    ...overrides,
  });

  return { store, stream, note, engine };
}

describe("RecorderEngine", () => {
  beforeEach(() => {
    FakeMediaRecorder.resetForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("le test du DoD : 30 minutes continues produisent 6 segments numérotés 0 à 5 sans trou", async () => {
    const { store, engine, note } = await setup();
    await engine.start();

    await vi.advanceTimersByTimeAsync(6 * RECORDER_SEGMENT_MS);

    const segments = await store.listSegments(note.id);
    expect(segments).toHaveLength(6);
    expect(segments.map((s) => s.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const segment of segments) {
      expect(segment.durationMs).toBe(RECORDER_SEGMENT_MS);
    }
    expect(engine.getSnapshot().state).toBe("recording");
    expect(engine.getSnapshot().segmentCount).toBe(6);
  });

  it("persiste chaque segment AVANT que le cycle suivant ne démarre", async () => {
    const { store, engine } = await setup({ segmentMs: 1000 });
    const appendSpy = vi.spyOn(store, "appendSegment");
    await engine.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ seq: 0 }));

    await vi.advanceTimersByTimeAsync(1000);
    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(appendSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ seq: 1 }));
  });

  it("chaque segment est complet et autonome : mimeType et blob renseignés", async () => {
    const { store, engine, note } = await setup({ segmentMs: 500 });
    await engine.start();
    await vi.advanceTimersByTimeAsync(500);

    const segments = await store.listSegments(note.id);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.mimeType).toBe("audio/webm;codecs=opus");
    expect(segments[0]?.blob).toBeInstanceOf(Blob);
    expect(segments[0]?.blob.size).toBeGreaterThan(0);
  });

  it("pause puis reprise : exclut le temps de pause du calcul de durée, ne perd aucun segment", async () => {
    const { store, engine, note } = await setup({ segmentMs: 5000 });
    await engine.start();

    await vi.advanceTimersByTimeAsync(2000);
    await engine.pause();

    // Une longue pause ne doit jamais faire progresser la durée ni créer de segment.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engine.getSnapshot().segmentCount).toBe(1);
    expect(engine.getSnapshot().elapsedMs).toBe(2000);

    await engine.resume();
    await vi.advanceTimersByTimeAsync(5000);

    const segments = await store.listSegments(note.id);
    expect(segments.map((s) => s.seq)).toEqual([0, 1]);
    expect(segments[0]?.durationMs).toBe(2000);
    expect(segments[1]?.durationMs).toBe(5000);
    // 2s + 5s de temps actif, la minute de pause n'est pas comptée.
    expect(engine.getSnapshot().elapsedMs).toBe(7000);

    const persistedNote = await store.getNote(note.id);
    expect(persistedNote?.durationMs).toBe(7000);
  });

  it("notifie les abonnés (subscribe) à chaque rotation normale de segment, pas seulement à la pause/l'arrêt/le plafond", async () => {
    const { engine } = await setup({ segmentMs: 1000 });
    const listener = vi.fn();
    engine.subscribe(listener);

    await engine.start();
    listener.mockClear(); // ignore l'émission initiale de start()

    await vi.advanceTimersByTimeAsync(1000);

    expect(listener).toHaveBeenCalled();
    const lastSnapshot = listener.mock.calls.at(-1)?.[0] as { segmentCount: number; state: string };
    expect(lastSnapshot.segmentCount).toBe(1);
    expect(lastSnapshot.state).toBe("recording");
  });

  it("pause() est refusée si l'enregistrement n'est pas en cours, sans corrompre l'état", async () => {
    const { store, engine } = await setup();
    const appendSpy = vi.spyOn(store, "appendSegment");

    await expect(engine.pause()).rejects.toBeInstanceOf(InvalidRecorderTransitionError);
    expect(engine.getSnapshot().state).toBe("idle");
    expect(appendSpy).not.toHaveBeenCalled();

    // L'état n'ayant pas été corrompu, un démarrage normal doit ensuite fonctionner.
    await engine.start();
    expect(engine.getSnapshot().state).toBe("recording");
  });

  it("stop() est refusé depuis idle, sans corrompre l'état", async () => {
    const { engine } = await setup();
    await expect(engine.stop()).rejects.toBeInstanceOf(InvalidRecorderTransitionError);
    expect(engine.getSnapshot().state).toBe("idle");
  });

  it("stop() ferme proprement le segment en cours (durée partielle) et s'arrête", async () => {
    const { store, engine, note } = await setup({ segmentMs: 10_000 });
    await engine.start();
    await vi.advanceTimersByTimeAsync(3000);
    await engine.stop();

    const segments = await store.listSegments(note.id);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.durationMs).toBe(3000);
    expect(engine.getSnapshot().state).toBe("stopped");
  });

  it("plafond de durée : arrêt automatique propre avec message français, sans dépasser le plafond", async () => {
    const { store, engine, note } = await setup({ segmentMs: 5000, maxDurationMs: 12_000 });
    const listener = vi.fn();
    engine.subscribe(listener);

    await engine.start();
    await vi.advanceTimersByTimeAsync(12_000);

    const snapshot = engine.getSnapshot();
    expect(snapshot.state).toBe("stopped");
    expect(snapshot.elapsedMs).toBe(12_000);
    expect(snapshot.error?.code).toBe("max-duration-reached");
    expect(snapshot.error?.message).toMatch(/2 heures/); // message générique du code, indépendant du plafond de test

    const segments = await store.listSegments(note.id);
    expect(segments.map((s) => s.durationMs)).toEqual([5000, 5000, 2000]);
    expect(
      listener.mock.calls.some(([s]) => (s as { error?: { code?: string } }).error?.code === "max-duration-reached"),
    ).toBe(true);
  });

  it("MediaRecorder.isTypeSupported renvoyant faux partout → échec propre, message français, état error", async () => {
    const { store, engine, note } = await setup();
    FakeMediaRecorder.supportedTypes = new Set(); // aucun type supporté, appliqué après setup()

    await expect(engine.start()).rejects.toMatchObject({
      code: "no-supported-mime-type",
      message: expect.stringMatching(/navigateur/i),
    });
    expect(engine.getSnapshot().state).toBe("error");
    expect(await store.listSegments(note.id)).toEqual([]);
  });

  it("une erreur à l'arrêt du MediaRecorder remonte comme RecorderError sans planter le moteur", async () => {
    const { engine } = await setup({ segmentMs: 5000 });
    await engine.start();
    const [recorder] = FakeMediaRecorder.instances;
    if (recorder) recorder.failOnStop = true;

    await expect(engine.stop()).rejects.toMatchObject({ code: "unknown" });
  });

  it("dispose() nettoie le minuteur sans lever, y compris depuis idle", () => {
    const stream = createFakeMediaStream();
    const store = createFakeNoteStore();
    const engine = new RecorderEngine({
      store,
      noteId: "peu-importe",
      stream,
      createMediaRecorder: (s, o) => new FakeMediaRecorder(s, o) as unknown as MediaRecorder,
      isTypeSupported: (t) => FakeMediaRecorder.isTypeSupported(t),
    });
    expect(() => engine.dispose()).not.toThrow();
  });

  describe("reprise d'une note existante (refresh en cours d'enregistrement)", () => {
    it("reprend la numérotation après les segments déjà persistés : le prochain seq est le max existant + 1, pas 0", async () => {
      const { store, engine, note } = await setup({ segmentMs: 1000 });
      // Simule une note déjà enregistrée sur 3 segments (seq 0, 1, 2) avant un refresh.
      for (let seq = 0; seq < 3; seq += 1) {
        await store.appendSegment({
          noteId: note.id,
          seq,
          blob: new Blob([`déjà-persisté-${seq}`]),
          mimeType: "audio/webm;codecs=opus",
          durationMs: 1000,
        });
      }

      // Même noteId qu'à la construction : c'est une reprise, pas une nouvelle note.
      await engine.start();
      expect(engine.getSnapshot().segmentCount).toBe(3);
      expect(engine.getSnapshot().elapsedMs).toBe(3000);

      await vi.advanceTimersByTimeAsync(1000); // ferme le 4e segment de la note

      const segments = await store.listSegments(note.id);
      expect(segments.map((s) => s.seq)).toEqual([0, 1, 2, 3]);
      expect(engine.getSnapshot().segmentCount).toBe(4);
    });

    it("recharge la durée cumulée depuis les segments existants, pas depuis un compteur en mémoire", async () => {
      const { store, engine, note } = await setup({ segmentMs: 1000 });
      await store.appendSegment({
        noteId: note.id,
        seq: 0,
        blob: new Blob(["a"]),
        mimeType: "audio/webm;codecs=opus",
        durationMs: 4000,
      });

      await engine.start();
      expect(engine.getSnapshot().elapsedMs).toBe(4000);

      await vi.advanceTimersByTimeAsync(1000);
      expect(engine.getSnapshot().elapsedMs).toBe(5000);

      const persistedNote = await store.getNote(note.id);
      expect(persistedNote?.durationMs).toBe(5000);
    });

    it("le plafond de durée s'applique au cumul de la note, pas à la seule session en cours", async () => {
      const { store, engine, note } = await setup({ segmentMs: 5000, maxDurationMs: 10_000 });
      await store.appendSegment({
        noteId: note.id,
        seq: 0,
        blob: new Blob(["a"]),
        mimeType: "audio/webm;codecs=opus",
        durationMs: 9000,
      });

      await engine.start();
      // Il ne reste que 1000 ms de budget avant le plafond de 10 000 ms.
      await vi.advanceTimersByTimeAsync(1000);

      const snapshot = engine.getSnapshot();
      expect(snapshot.state).toBe("stopped");
      expect(snapshot.error?.code).toBe("max-duration-reached");
      expect(snapshot.elapsedMs).toBe(10_000);
      expect((await store.listSegments(note.id)).map((s) => s.durationMs)).toEqual([9000, 1000]);
    });

    it("reprendre une note inexistante échoue proprement avec un message français, jamais une InvalidRecorderTransitionError", async () => {
      FakeMediaRecorder.supportedTypes = new Set(["audio/webm;codecs=opus"]);
      const store = createFakeNoteStore();
      const stream = createFakeMediaStream();
      const engine = new RecorderEngine({
        store,
        noteId: "note-jamais-creee",
        stream,
        createMediaRecorder: (s, o) => new FakeMediaRecorder(s, o) as unknown as MediaRecorder,
        isTypeSupported: (t) => FakeMediaRecorder.isTypeSupported(t),
      });

      await expect(engine.start()).rejects.toMatchObject({
        code: "note-not-found",
        message: expect.stringMatching(/n'existe plus/),
      });
      expect(engine.getSnapshot().state).toBe("error");

      // Un second essai sur la même note absente doit rester une RecorderError
      // propre (l'auto-boucle error→ERROR de la machine sert précisément ça).
      await expect(engine.start()).rejects.toMatchObject({ code: "note-not-found" });
      expect(engine.getSnapshot().state).toBe("error");
    });
  });
});
