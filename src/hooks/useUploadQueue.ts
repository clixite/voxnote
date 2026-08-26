"use client";

/**
 * Hook fin sur `UploadQueue` (src/lib/upload/queue.ts) : toute la logique de
 * file/retry/backoff vit dans cette classe pure, testable sans React (comme
 * `useRecorder` au-dessus de `RecorderEngine`). Ce hook se contente de :
 *
 * - créer la file une seule fois et la démarrer/arrêter avec le cycle de vie
 *   React (`start()`/`stop()` sont des bascules idempotentes — voir queue.ts —
 *   donc un double montage StrictMode ne pose pas de problème) ;
 * - relayer l'événement navigateur `online` vers `queue.wake()`, seul lien
 *   entre la file (pure) et le réseau réel ;
 * - exposer un instantané réactif (`globalStatus`, `pendingCount`) et, si un
 *   `noteId` est fourni, la progression de CETTE note (segments uploadés /
 *   transcrits / en erreur) relue depuis le `NoteStore` à chaque changement ;
 * - fournir à la file l'identifiant de CET onglet (réservation de segment,
 *   B2) — réutilisé tel quel depuis `activeRecordingMarker.ts`, jamais un
 *   second identifiant concurrent : deux identifiants d'onglet différents
 *   dans la même appli rendraient la réservation inefficace pour la
 *   reprise après refresh (voir `getTabId()`, scope `sessionStorage`).
 */
import { useEffect, useMemo, useState } from "react";

import { getTabId } from "@/components/activeRecordingMarker";
import { computeNoteProgress, type NoteProgress } from "@/lib/upload/noteRollup";
import { transcribeSegmentBlob, uploadSegmentBlob } from "@/lib/upload/transport";
import {
  UploadQueue,
  type QueueGlobalStatus,
  type TranscribeSegmentFn,
  type UploadSegmentFn,
} from "@/lib/upload/queue";
import { createIndexedDbNoteStore } from "@/lib/store/indexeddb";
import type { NoteStore } from "@/types/notes";

/**
 * Sous-ensemble de `Window` utilisé ici, dans le même esprit que
 * `DocumentVisibilityLike` de `useWakeLock.ts` : simple à injecter en test,
 * indépendant des surcharges d'`addEventListener` des types DOM ambiants.
 */
export interface WindowOnlineLike {
  addEventListener(type: "online" | "offline", listener: () => void): void;
  removeEventListener(type: "online" | "offline", listener: () => void): void;
}

export interface UseUploadQueueOptions {
  /** Injectable pour les tests. Défaut : la vraie base IndexedDB de production. */
  store?: NoteStore;
  /** Note dont on veut la progression détaillée (l'écran d'enregistrement, typiquement). */
  noteId?: string;
  /** Injectables pour les tests ; par défaut l'upload Blob réel et l'appel à /api/transcribe. */
  uploadSegment?: UploadSegmentFn;
  transcribeSegment?: TranscribeSegmentFn;
  concurrency?: number;
  /** Injectable pour les tests. Défaut : `window`. */
  windowRef?: WindowOnlineLike;
  /** Injectable pour les tests. Défaut : `() => navigator.onLine`. */
  isOnline?: () => boolean;
  /** Injectable pour les tests. Défaut : `getTabId()` (même identifiant que le marqueur d'enregistrement). */
  tabId?: string;
}

export interface UseUploadQueueResult {
  globalStatus: QueueGlobalStatus;
  /** Segments encore à uploader ou à transcrire, toutes notes confondues. */
  pendingCount: number;
  /** Progression de `noteId` (undefined si `noteId` omis, ou note sans le moindre segment). */
  noteProgress: NoteProgress | undefined;
  /** Bouton « Réessayer » d'un segment précis. */
  retrySegment: (segmentId: string) => void;
  /** À appeler juste après qu'un nouveau segment a été persisté (voir RecorderEngine). */
  notifyNewSegments: () => void;
}

function getGlobalWindow(): WindowOnlineLike | undefined {
  return typeof window === "undefined" ? undefined : window;
}

export function useUploadQueue(options: UseUploadQueueOptions = {}): UseUploadQueueResult {
  const [store] = useState<NoteStore>(() => options.store ?? createIndexedDbNoteStore());
  const windowRef = options.windowRef ?? getGlobalWindow();

  // Créée une seule fois (initialiseur paresseux de useState, jamais un ref
  // lu pendant le rendu) : recréer la file à chaque rendu recommencerait le
  // backoff en cours et casserait le plafond de concurrence en vol.
  const [queue] = useState(
    () =>
      new UploadQueue({
        store,
        uploadSegment: options.uploadSegment ?? uploadSegmentBlob,
        transcribeSegment: options.transcribeSegment ?? transcribeSegmentBlob,
        concurrency: options.concurrency,
        isOnline: options.isOnline,
        tabId: options.tabId ?? getTabId(),
      }),
  );

  const [snapshot, setSnapshot] = useState(() => queue.getSnapshot());
  // `undefined` : soit `noteId` n'est pas fourni, soit sa progression n'a pas
  // encore été lue — jamais remis à `undefined` en effet pour switcher de
  // note (voir la lecture ci-dessous, gardée par `noteId` au moment du
  // retour plutôt que par un setState synchrone dans l'effet).
  const [rawNoteProgress, setRawNoteProgress] = useState<NoteProgress | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = queue.subscribe(setSnapshot);
    void queue.start();
    return () => {
      unsubscribe();
      queue.stop();
    };
  }, [queue]);

  useEffect(() => {
    if (!windowRef) return;
    const handleOnline = () => void queue.wake();
    windowRef.addEventListener("online", handleOnline);
    return () => windowRef.removeEventListener("online", handleOnline);
  }, [queue, windowRef]);

  const noteId = options.noteId;
  useEffect(() => {
    if (!noteId) return;
    let cancelled = false;
    store
      .listSegments(noteId)
      .then((segments) => {
        if (!cancelled) setRawNoteProgress(computeNoteProgress(segments));
      })
      .catch(() => {
        // Note supprimée entre-temps ou panne de lecture ponctuelle : la
        // prochaine relecture (revision suivante) rattrapera l'état réel.
      });
    return () => {
      cancelled = true;
    };
    // `snapshot.revision` change à chaque écriture de la file : c'est le
    // signal de relecture (voir queue.ts).
  }, [store, noteId, snapshot.revision]);

  const noteProgress = noteId ? rawNoteProgress : undefined;

  return useMemo(
    () => ({
      globalStatus: snapshot.globalStatus,
      pendingCount: snapshot.pendingCount,
      noteProgress,
      retrySegment: (segmentId: string) => void queue.retrySegment(segmentId),
      notifyNewSegments: () => void queue.wake(),
    }),
    [snapshot, noteProgress, queue],
  );
}
