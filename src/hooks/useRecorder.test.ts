import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecorderError } from "@/lib/recorder/errors";
import {
  createFakeMediaStream,
  createFakeNoteStore,
  FakeMediaRecorder,
} from "@/lib/recorder/test-utils";

import { useRecorder } from "./useRecorder";

function setSupported(...types: string[]) {
  FakeMediaRecorder.resetForTests();
  FakeMediaRecorder.supportedTypes = new Set(types);
}

describe("useRecorder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("permission refusée → message français, état error, aucune note créée", async () => {
    setSupported("audio/webm;codecs=opus");
    const store = createFakeNoteStore();
    const createNoteSpy = vi.spyOn(store, "createNote");
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("refusé", "NotAllowedError");
    });

    const { result } = renderHook(() =>
      useRecorder({
        store,
        getUserMedia,
        isTypeSupported: (t) => FakeMediaRecorder.isTypeSupported(t),
      }),
    );

    await act(async () => {
      await expect(result.current.start("fr")).rejects.toBeInstanceOf(RecorderError);
    });

    expect(result.current.state).toBe("error");
    expect(result.current.errorMessage).toMatch(/refusé/i);
    expect(result.current.errorMessage).not.toMatch(/NotAllowedError/);
    expect(result.current.errorCode).toBe("permission-denied");
    expect(createNoteSpy).not.toHaveBeenCalled();
  });

  it("aucun mimeType supporté → échec propre, aucune demande de permission, aucune note créée", async () => {
    setSupported(); // aucun type supporté
    const store = createFakeNoteStore();
    const createNoteSpy = vi.spyOn(store, "createNote");
    const getUserMedia = vi.fn();

    const { result } = renderHook(() =>
      useRecorder({
        store,
        getUserMedia,
        isTypeSupported: (t) => FakeMediaRecorder.isTypeSupported(t),
      }),
    );

    await act(async () => {
      await expect(result.current.start("fr")).rejects.toMatchObject({
        code: "no-supported-mime-type",
      });
    });

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(createNoteSpy).not.toHaveBeenCalled();
    expect(result.current.mimeTypeSupported).toBe(false);
    expect(result.current.errorMessage).toMatch(/navigateur/i);
    expect(result.current.errorCode).toBe("no-supported-mime-type");
  });

  it("micro déjà utilisé par une autre application → message français dédié", async () => {
    setSupported("audio/webm;codecs=opus");
    const store = createFakeNoteStore();
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("busy", "NotReadableError");
    });

    const { result } = renderHook(() =>
      useRecorder({ store, getUserMedia, isTypeSupported: (t) => FakeMediaRecorder.isTypeSupported(t) }),
    );

    await act(async () => {
      await expect(result.current.start("fr")).rejects.toMatchObject({ code: "microphone-busy" });
    });
    expect(result.current.errorMessage).toMatch(/déjà utilisé/);
    expect(result.current.errorCode).toBe("microphone-busy");
  });

  it("si l'engine échoue à démarrer après getUserMedia, nettoie la note orpheline et la piste micro", async () => {
    setSupported(); // engine.start() détectera aussi l'absence de mimeType, mais ici on force via createMediaRecorder qui jette
    FakeMediaRecorder.supportedTypes = new Set(["audio/webm;codecs=opus"]);
    const store = createFakeNoteStore();
    const deleteNoteSpy = vi.spyOn(store, "deleteNote");
    const stream = createFakeMediaStream();
    const stopTrack = vi.fn();
    stream.getTracks = () => [{ kind: "audio", readyState: "live", stop: stopTrack } as unknown as MediaStreamTrack];
    const getUserMedia = vi.fn(async () => stream);
    const createMediaRecorder = vi.fn(() => {
      throw new Error("device error");
    });

    const { result } = renderHook(() =>
      useRecorder({
        store,
        getUserMedia,
        isTypeSupported: (t) => FakeMediaRecorder.isTypeSupported(t),
        createMediaRecorder,
      }),
    );

    await act(async () => {
      await expect(result.current.start("fr")).rejects.toBeTruthy();
    });

    expect(deleteNoteSpy).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  describe("reprise d'une note existante (start(lang, { noteId }))", () => {
    it("reprend au lieu de créer : pas de createNote, engine reçoit le noteId fourni", async () => {
      setSupported("audio/webm;codecs=opus");
      const store = createFakeNoteStore();
      const existingNote = await store.createNote({ lang: "fr" });
      await store.appendSegment({
        noteId: existingNote.id,
        seq: 0,
        blob: new Blob(["a"]),
        mimeType: "audio/webm;codecs=opus",
        durationMs: 4000,
      });
      const createNoteSpy = vi.spyOn(store, "createNote");
      const stream = createFakeMediaStream();
      const getUserMedia = vi.fn(async () => stream);

      const { result } = renderHook(() =>
        useRecorder({
          store,
          getUserMedia,
          isTypeSupported: (t) => FakeMediaRecorder.isTypeSupported(t),
          createMediaRecorder: (s, o) => new FakeMediaRecorder(s, o) as unknown as MediaRecorder,
        }),
      );

      await act(async () => {
        await result.current.start("fr", { noteId: existingNote.id });
      });

      expect(createNoteSpy).not.toHaveBeenCalled();
      expect(result.current.noteId).toBe(existingNote.id);
      expect(result.current.state).toBe("recording");
      // La durée déjà persistée (un segment de 4 s) est immédiatement visible.
      expect(result.current.elapsedMs).toBe(4000);
      expect(result.current.segmentCount).toBe(1);
    });

    it("noteId inexistant → échec propre, message français, aucune demande de permission micro", async () => {
      setSupported("audio/webm;codecs=opus");
      const store = createFakeNoteStore();
      const getUserMedia = vi.fn();

      const { result } = renderHook(() =>
        useRecorder({ store, getUserMedia, isTypeSupported: (t) => FakeMediaRecorder.isTypeSupported(t) }),
      );

      await act(async () => {
        await expect(result.current.start("fr", { noteId: "note-jamais-creee" })).rejects.toMatchObject(
          { code: "note-not-found" },
        );
      });

      expect(getUserMedia).not.toHaveBeenCalled();
      expect(result.current.state).toBe("error");
      expect(result.current.errorCode).toBe("note-not-found");
      expect(result.current.errorMessage).toMatch(/n'existe plus/);
    });

    it("si le démarrage échoue après permission accordée, NE supprime PAS la note reprise (contrairement à une note fraîchement créée)", async () => {
      setSupported("audio/webm;codecs=opus");
      const store = createFakeNoteStore();
      const existingNote = await store.createNote({ lang: "fr" });
      const deleteNoteSpy = vi.spyOn(store, "deleteNote");
      const stream = createFakeMediaStream();
      const getUserMedia = vi.fn(async () => stream);
      const createMediaRecorder = vi.fn(() => {
        throw new Error("device error");
      });

      const { result } = renderHook(() =>
        useRecorder({ store, getUserMedia, isTypeSupported: (t) => FakeMediaRecorder.isTypeSupported(t), createMediaRecorder }),
      );

      await act(async () => {
        await expect(result.current.start("fr", { noteId: existingNote.id })).rejects.toBeTruthy();
      });

      expect(deleteNoteSpy).not.toHaveBeenCalled();
      expect(await store.getNote(existingNote.id)).toBeDefined();
    });
  });

  it("enregistre, segmente via RecorderEngine, et s'arrête proprement", async () => {
    vi.useFakeTimers();
    setSupported("audio/webm;codecs=opus");
    const store = createFakeNoteStore();
    const stream = createFakeMediaStream();
    const getUserMedia = vi.fn(async () => stream);

    const { result } = renderHook(() =>
      useRecorder({
        store,
        getUserMedia,
        isTypeSupported: (t) => FakeMediaRecorder.isTypeSupported(t),
        createMediaRecorder: (s, o) => new FakeMediaRecorder(s, o) as unknown as MediaRecorder,
        segmentMs: 1000,
      }),
    );

    await act(async () => {
      await result.current.start("fr");
    });
    expect(result.current.state).toBe("recording");
    expect(result.current.noteId).toBeDefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.segmentCount).toBe(1);

    await act(async () => {
      await result.current.pause();
    });
    expect(result.current.state).toBe("paused");

    await act(async () => {
      await result.current.resume();
    });
    expect(result.current.state).toBe("recording");

    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.state).toBe("stopped");
  });

  describe("VU-mètre / AudioContext (piège iOS, skill audio-web)", () => {
    class FakeAnalyser {
      fftSize = 512;
      getByteTimeDomainData = vi.fn();
    }

    function makeFakeAudioContextClass(resumeChangesState: boolean) {
      return class {
        state: "suspended" | "running" | "closed" = "suspended";
        resume = vi.fn(async () => {
          if (resumeChangesState) this.state = "running";
        });
        close = vi.fn(async () => {
          this.state = "closed";
        });
        createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
        createAnalyser = vi.fn(() => new FakeAnalyser());
      };
    }

    beforeEach(() => {
      vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
    });

    it("tente resume() sur un AudioContext suspendu dès le démarrage", async () => {
      setSupported("audio/webm;codecs=opus");
      const store = createFakeNoteStore();
      const stream = createFakeMediaStream();
      const getUserMedia = vi.fn(async () => stream);
      const FakeCtx = makeFakeAudioContextClass(true);
      let created: InstanceType<typeof FakeCtx> | undefined;

      const { result } = renderHook(() =>
        useRecorder({
          store,
          getUserMedia,
          isTypeSupported: (t) => FakeMediaRecorder.isTypeSupported(t),
          createMediaRecorder: (s, o) => new FakeMediaRecorder(s, o) as unknown as MediaRecorder,
          createAudioContext: () => {
            created = new FakeCtx();
            return created as unknown as AudioContext;
          },
        }),
      );

      await act(async () => {
        await result.current.start("fr");
      });

      expect(created?.resume).toHaveBeenCalledTimes(1);
    });

    it("resumeAudioContext() relance resume() si le contexte est resté suspendu", async () => {
      setSupported("audio/webm;codecs=opus");
      const store = createFakeNoteStore();
      const stream = createFakeMediaStream();
      const getUserMedia = vi.fn(async () => stream);
      const FakeCtx = makeFakeAudioContextClass(false); // resume() ne change jamais l'état
      let created: InstanceType<typeof FakeCtx> | undefined;

      const { result } = renderHook(() =>
        useRecorder({
          store,
          getUserMedia,
          isTypeSupported: (t) => FakeMediaRecorder.isTypeSupported(t),
          createMediaRecorder: (s, o) => new FakeMediaRecorder(s, o) as unknown as MediaRecorder,
          createAudioContext: () => {
            created = new FakeCtx();
            return created as unknown as AudioContext;
          },
        }),
      );

      await act(async () => {
        await result.current.start("fr");
      });
      expect(created?.resume).toHaveBeenCalledTimes(1);

      await act(async () => {
        await result.current.resumeAudioContext();
      });
      expect(created?.resume).toHaveBeenCalledTimes(2);
    });
  });
});
