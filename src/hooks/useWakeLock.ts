"use client";

/**
 * Wake Lock (garder l'écran allumé pendant l'enregistrement) : voir la skill
 * `audio-web`, section Safari iOS — l'OS relâche le verrou dès que l'onglet
 * passe en arrière-plan, il faut donc le re-demander explicitement au retour
 * au premier plan (`visibilitychange`), sans quoi il ne sert plus à rien après
 * le premier basculement.
 *
 * Interfaces minimales définies ici plutôt que de dépendre des types DOM
 * ambiants pour `navigator.wakeLock` : on reste robuste même si le lib DOM du
 * projet ne les fournit pas, et ça simplifie l'injection en test.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
  removeEventListener(type: "release", listener: () => void): void;
}

export interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

export type WakeLockStatus = "idle" | "active" | "released" | "unsupported" | "error";

/**
 * Sous-ensemble de `Document` utilisé ici, indépendant des types DOM ambigus
 * (surcharges d'`addEventListener`) pour rester simple à injecter en test.
 */
export interface DocumentVisibilityLike {
  readonly visibilityState: "visible" | "hidden";
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface UseWakeLockOptions {
  /** Injectable pour les tests. Défaut : `navigator.wakeLock`. */
  wakeLock?: WakeLockLike;
  /** Injectable pour les tests. Défaut : `document`. */
  documentRef?: DocumentVisibilityLike;
}

export interface UseWakeLockResult {
  /** `false` si l'API Wake Lock est absente : l'UI doit afficher un bandeau d'avertissement. */
  supported: boolean;
  status: WakeLockStatus;
  request: () => Promise<void>;
  release: () => Promise<void>;
}

function getGlobalWakeLock(): WakeLockLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
}

function getGlobalDocument(): DocumentVisibilityLike | undefined {
  return typeof document === "undefined" ? undefined : (document as unknown as DocumentVisibilityLike);
}

export function useWakeLock(options: UseWakeLockOptions = {}): UseWakeLockResult {
  const wakeLockApi = options.wakeLock ?? getGlobalWakeLock();
  const doc = options.documentRef ?? getGlobalDocument();
  const supported = Boolean(wakeLockApi);

  const [status, setStatus] = useState<WakeLockStatus>(supported ? "idle" : "unsupported");
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);
  // Référence à l'écouteur "release" actuellement attaché à `sentinelRef.current`,
  // pour pouvoir le retirer avant de changer de sentinelle (C9 de la revue :
  // sans ça, chaque re-demande accumule un écouteur orphelin sur l'ancienne
  // sentinelle, jamais retiré).
  const releaseListenerRef = useRef<(() => void) | null>(null);
  // true tant que l'appelant veut le verrou actif : c'est ce qui déclenche la
  // re-demande au retour au premier plan (l'OS l'a relâché, pas nous).
  const wantActiveRef = useRef(false);

  /** Détache l'écouteur "release" de la sentinelle actuelle, sans la relâcher. */
  const detachCurrentSentinel = useCallback((): void => {
    const sentinel = sentinelRef.current;
    const listener = releaseListenerRef.current;
    if (sentinel && listener) {
      sentinel.removeEventListener("release", listener);
    }
    releaseListenerRef.current = null;
  }, []);

  const request = useCallback(async (): Promise<void> => {
    wantActiveRef.current = true;
    if (!wakeLockApi) {
      setStatus("unsupported");
      return;
    }
    try {
      const sentinel = await wakeLockApi.request("screen");

      // Une sentinelle précédente (typiquement déjà relâchée par l'OS — c'est
      // précisément pourquoi on re-demande) ne doit jamais s'accumuler : on
      // détache son écouteur et on la relâche si besoin avant d'adopter la
      // nouvelle (C9).
      const stale = sentinelRef.current;
      if (stale && stale !== sentinel) {
        detachCurrentSentinel();
        if (!stale.released) {
          stale.release().catch(() => {
            // Best-effort : la sentinelle est de toute façon abandonnée.
          });
        }
      }

      sentinelRef.current = sentinel;
      setStatus("active");
      const handleRelease = (): void => {
        setStatus((current) => (current === "active" ? "released" : current));
      };
      releaseListenerRef.current = handleRelease;
      sentinel.addEventListener("release", handleRelease);
    } catch {
      setStatus("error");
    }
  }, [wakeLockApi, detachCurrentSentinel]);

  const release = useCallback(async (): Promise<void> => {
    wantActiveRef.current = false;
    const sentinel = sentinelRef.current;
    detachCurrentSentinel();
    sentinelRef.current = null;
    if (sentinel && !sentinel.released) {
      try {
        await sentinel.release();
      } catch {
        // Best-effort (C9) : le rejet de sentinel.release() ne doit jamais
        // remonter à l'appelant — le statut retombe à idle/unsupported dans
        // tous les cas, ci-dessous.
      }
    }
    setStatus(supported ? "idle" : "unsupported");
  }, [supported, detachCurrentSentinel]);

  useEffect(() => {
    if (!doc || !wakeLockApi) return;
    const handleVisibilityChange = (): void => {
      if (doc.visibilityState === "visible" && wantActiveRef.current) {
        void request();
      }
    };
    doc.addEventListener("visibilitychange", handleVisibilityChange);
    return () => doc.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [doc, wakeLockApi, request]);

  useEffect(() => {
    return () => {
      detachCurrentSentinel();
      const sentinel = sentinelRef.current;
      if (sentinel && !sentinel.released) {
        sentinel.release().catch(() => {
          // Démontage : plus personne n'observe le résultat.
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nettoyage au démontage uniquement
  }, []);

  return { supported, status, request, release };
}
