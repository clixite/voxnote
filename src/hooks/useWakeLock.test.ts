import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useWakeLock, type DocumentVisibilityLike, type WakeLockSentinelLike } from "./useWakeLock";

function createFakeSentinel(): WakeLockSentinelLike & { emitRelease: () => void } {
  let released = false;
  const listeners = new Set<() => void>();
  return {
    get released() {
      return released;
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
});
