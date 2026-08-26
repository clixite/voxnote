import type { Page } from "@playwright/test";

export type WakeLockMode = "absent" | "working";

/**
 * Contrôle `navigator.wakeLock` pour les deux scénarios du bandeau
 * d'avertissement (voir `WakeLockBanner.tsx` et la skill `audio-web`) :
 * `"absent"` supprime l'API (cas Safari ancien), `"working"` fournit une
 * implémentation qui accorde toujours le verrou avec succès.
 *
 * Nécessaire même sous Chromium headless : sans ce double, `navigator.wakeLock`
 * y est bien présent mais `.request()` y rejette systématiquement
 * (`NotAllowedError: Wake Lock permission request denied`, vérifié), ce qui
 * ferait apparaître le bandeau par accident (état "error", traité comme
 * "unsupported" par `RecorderScreen`) plutôt que de démontrer intentionnellement
 * les deux états attendus par le critère P2-3.
 */
export async function installWakeLock(page: Page, mode: WakeLockMode): Promise<void> {
  await page.addInitScript((initMode: WakeLockMode) => {
    if (initMode === "absent") {
      Object.defineProperty(navigator, "wakeLock", {
        value: undefined,
        configurable: true,
      });
      return;
    }

    const listeners = new Set<() => void>();
    const sentinel = {
      released: false,
      release: async (): Promise<void> => {
        sentinel.released = true;
        listeners.forEach((listener) => listener());
      },
      addEventListener: (_type: "release", listener: () => void): void => {
        listeners.add(listener);
      },
      removeEventListener: (_type: "release", listener: () => void): void => {
        listeners.delete(listener);
      },
    };

    Object.defineProperty(navigator, "wakeLock", {
      value: {
        request: async () => sentinel,
      },
      configurable: true,
    });
  }, mode);
}
