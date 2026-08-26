import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useWakeLock, type DocumentVisibilityLike, type WakeLockSentinelLike } from "./useWakeLock";

function createFakeSentinel(): WakeLockSentinelLike & {
  emitRelease: () => void;
  /** Nombre d'écouteurs "release" actuellement attachés (C9 : ne doit pas s'accumuler). */
  readonly listenerCount: number;
} {
  let released = false;
  const listeners = new Set<() => void>();
  return {
    get released() {
      return released;
    },
    get listenerCount() {
      return listeners.size;
    },
    async release() {
      released = true;
      listeners.forEach((l) => l());
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    emitRelease() {
      released = true;
      listeners.forEach((l) => l());
    },
  };
}

function createFakeDocument(): DocumentVisibilityLike & {
  setVisible: (visible: boolean) => void;
} {
  let visibilityState: "visible" | "hidden" = "visible";
  const listeners = new Set<() => void>();
  return {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    setVisible(visible: boolean) {
      visibilityState = visible ? "visible" : "hidden";
      listeners.forEach((l) => l());
    },
  };
}

describe("useWakeLock", () => {
  it("absence de navigator.wakeLock : pas d'exception, indisponibilité signalée", async () => {
    const { result } = renderHook(() => useWakeLock({ wakeLock: undefined }));
    expect(result.current.supported).toBe(false);
    expect(result.current.status).toBe("unsupported");

    await act(async () => {
      await result.current.request();
    });
    expect(result.current.status).toBe("unsupported");
  });

  it("request() demande le verrou et passe à 'active'", async () => {
    const sentinel = createFakeSentinel();
    const wakeLock = { request: vi.fn(async () => sentinel) };
    const { result } = renderHook(() => useWakeLock({ wakeLock }));

    expect(result.current.supported).toBe(true);
    await act(async () => {
      await result.current.request();
    });

    expect(wakeLock.request).toHaveBeenCalledWith("screen");
    expect(result.current.status).toBe("active");
  });

  it("release() relâche le verrou et repasse à 'idle'", async () => {
    const sentinel = createFakeSentinel();
    const wakeLock = { request: vi.fn(async () => sentinel) };
    const { result } = renderHook(() => useWakeLock({ wakeLock }));

    await act(async () => {
      await result.current.request();
    });
    await act(async () => {
      await result.current.release();
    });

    expect(sentinel.released).toBe(true);
    expect(result.current.status).toBe("idle");
  });

  it("re-demande le verrou au retour au premier plan après relâchement par l'OS", async () => {
    const sentinels = [createFakeSentinel(), createFakeSentinel()];
    let call = 0;
    const wakeLock = {
      request: vi.fn(async () => {
        const s = sentinels[call];
        call += 1;
        return s!;
      }),
    };
    const doc = createFakeDocument();
    const { result } = renderHook(() => useWakeLock({ wakeLock, documentRef: doc }));

    await act(async () => {
      await result.current.request();
    });
    expect(wakeLock.request).toHaveBeenCalledTimes(1);

    // L'OS relâche le verrou (ex : passage en arrière-plan).
    await act(async () => {
      sentinels[0]!.emitRelease();
    });
    expect(result.current.status).toBe("released");

    // Retour au premier plan : re-demande automatique.
    await act(async () => {
      doc.setVisible(true);
    });
    expect(wakeLock.request).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("active");
  });

  it("ne re-demande pas si l'onglet passe caché puis revient sans qu'on ait jamais demandé le verrou", async () => {
    const wakeLock = { request: vi.fn(async () => createFakeSentinel()) };
    const doc = createFakeDocument();
    renderHook(() => useWakeLock({ wakeLock, documentRef: doc }));

    await act(async () => {
      doc.setVisible(false);
      doc.setVisible(true);
    });
    expect(wakeLock.request).not.toHaveBeenCalled();
  });

  describe("C9 (revue d'architecture) : pas d'accumulation de sentinelles ni d'écouteurs", () => {
    it("détache l'écouteur 'release' de l'ancienne sentinelle à chaque re-demande, sur plusieurs cycles", async () => {
      const sentinels = [createFakeSentinel(), createFakeSentinel(), createFakeSentinel()];
      let call = 0;
      const wakeLock = { request: vi.fn(async () => sentinels[call++]!) };
      const doc = createFakeDocument();
      const { result } = renderHook(() => useWakeLock({ wakeLock, documentRef: doc }));

      await act(async () => {
        await result.current.request();
      });
      expect(sentinels[0]!.listenerCount).toBe(1);

      await act(async () => {
        sentinels[0]!.emitRelease();
      });
      await act(async () => {
        doc.setVisible(true); // re-demande → adopte sentinels[1]
      });
      // Avant C9 : l'écouteur de sentinels[0] restait attaché pour toujours.
      expect(sentinels[0]!.listenerCount).toBe(0);
      expect(sentinels[1]!.listenerCount).toBe(1);

      await act(async () => {
        sentinels[1]!.emitRelease();
      });
      await act(async () => {
        doc.setVisible(false);
      });
      await act(async () => {
        doc.setVisible(true); // re-demande → adopte sentinels[2]
      });
      expect(sentinels[1]!.listenerCount).toBe(0);
      expect(sentinels[2]!.listenerCount).toBe(1);

      // Preuve directe qu'il n'y a plus d'écouteur fantôme sur les
      // sentinelles périmées : les redéclencher ne change plus rien.
      const statusBefore = result.current.status;
      await act(async () => {
        sentinels[0]!.emitRelease();
        sentinels[1]!.emitRelease();
      });
      expect(result.current.status).toBe(statusBefore);
    });

    it("relâche l'ancienne sentinelle (si elle ne l'était pas déjà) au moment d'en adopter une nouvelle", async () => {
      const stale = createFakeSentinel();
      const fresh = createFakeSentinel();
      let call = 0;
      const wakeLock = {
        request: vi.fn(async () => (call++ === 0 ? stale : fresh)),
      };
      const doc = createFakeDocument();
      const { result } = renderHook(() => useWakeLock({ wakeLock, documentRef: doc }));

      await act(async () => {
        await result.current.request();
      });
      expect(stale.released).toBe(false);

      // Retour au premier plan SANS que l'OS n'ait relâché `stale` au
      // préalable (scénario limite : la sentinelle est encore là, mais on
      // en redemande une, par ex. après un appel explicite à request()) :
      // avant C9, `stale` restait vivante, jamais relâchée, écouteur compris.
      await act(async () => {
        await result.current.request();
      });
      expect(stale.released).toBe(true);
      expect(stale.listenerCount).toBe(0);
    });

    it("release() ne laisse jamais fuiter le rejet de sentinel.release() sous-jacent", async () => {
      const sentinel = createFakeSentinel();
      vi.spyOn(sentinel, "release").mockRejectedValue(new Error("échec natif simulé"));
      const wakeLock = { request: vi.fn(async () => sentinel) };
      const { result } = renderHook(() => useWakeLock({ wakeLock }));

      await act(async () => {
        await result.current.request();
      });

      await act(async () => {
        await expect(result.current.release()).resolves.toBeUndefined();
      });
      expect(result.current.status).toBe("idle");
    });
  });
});
