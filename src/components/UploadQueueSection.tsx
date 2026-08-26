"use client";

/**
 * Isole tout ce qui dépend de `useUploadQueue` dans son propre composant,
 * pour une seule raison : les règles de React interdisent d'appeler un hook
 * conditionnellement, mais rien n'empêche de monter ou démonter
 * conditionnellement le COMPOSANT qui l'appelle. C'est exactement ce dont
 * RecorderScreen a besoin pour B2 — ne jamais faire tourner la file
 * d'upload/transcription tant qu'un autre onglet vivant détient la note
 * affichée (voir OtherTabNotice) : deux files tournant en parallèle sur les
 * mêmes segments en attente double l'upload ET la facturation de
 * transcription. RecorderScreen ne rend ce composant que lorsque c'est sûr ;
 * démonté, son effet d'arrêt (`queue.stop()`, dans useUploadQueue) coupe la
 * file pour de bon, pas seulement l'affichage.
 *
 * Reçoit `segmentCount` et `onAnnounce` en props plutôt que de dupliquer cet
 * état : RecorderScreen garde la seule source de vérité pour le compteur de
 * segments et la région aria-live partagée par tout l'écran.
 */
import { useEffect, useRef } from "react";

import { useUploadQueue, type WindowOnlineLike } from "@/hooks/useUploadQueue";
import type { TranscribeSegmentFn, UploadSegmentFn } from "@/lib/upload/queue";
import type { NoteStore } from "@/types/notes";

import OfflineQueueBanner from "./OfflineQueueBanner";
import UploadProgress from "./UploadProgress";

export interface UploadQueueSectionProps {
  store: NoteStore;
  /** Note dont la progression est affichée ; `undefined` = rien à suivre pour l'instant. */
  noteId: string | undefined;
  /** Nombre de segments déjà fermés, pour réveiller la file à chaque incrément. */
  segmentCount: number;
  onAnnounce: (text: string) => void;
  onRetry?: (segmentId: string) => void;
  uploadSegment?: UploadSegmentFn;
  transcribeSegment?: TranscribeSegmentFn;
  concurrency?: number;
  isOnline?: () => boolean;
  windowRef?: WindowOnlineLike;
}

export default function UploadQueueSection({
  store,
  noteId,
  segmentCount,
  onAnnounce,
  uploadSegment,
  transcribeSegment,
  concurrency,
  isOnline,
  windowRef,
}: UploadQueueSectionProps) {
  const uploadQueue = useUploadQueue({
    store,
    noteId,
    uploadSegment,
    transcribeSegment,
    concurrency,
    isOnline,
    windowRef,
  });

  // Réveille la file dès qu'un nouveau segment vient d'être écrit dans le
  // NoteStore, sans attendre son prochain passage périodique.
  const previousSegmentCountRef = useRef(segmentCount);
  useEffect(() => {
    const previous = previousSegmentCountRef.current;
    previousSegmentCountRef.current = segmentCount;
    if (segmentCount > previous) uploadQueue.notifyNewSegments();
  }, [segmentCount, uploadQueue]);

  // Annoncé seulement aux changements significatifs, jamais à chaque segment
  // envoyé/transcrit (même principe que le minuteur, voir TimerDisplay).
  // L'annonce EST la synchronisation avec un système externe ici (une
  // région aria-live consommée par un lecteur d'écran, hors de portée du
  // rendu React) — mais `onAnnounce` est un simple prop, pas un `setState`
  // local que la règle `set-state-in-effect` pourrait tracer, donc rien à
  // désactiver ici (contrairement à RecorderScreen, qui appelle `setAnnouncement`
  // directement).
  const previousStatusRef = useRef(uploadQueue.globalStatus);
  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = uploadQueue.globalStatus;
    if (previous === uploadQueue.globalStatus) return;

    if (uploadQueue.globalStatus === "offline") {
      onAnnounce(
        "Connexion perdue. Rien n'est perdu : l'envoi reprendra automatiquement au retour du réseau.",
      );
    } else if (previous === "offline") {
      onAnnounce("Connexion retrouvée : l'envoi reprend.");
    } else if (uploadQueue.globalStatus === "idle" && previous === "syncing") {
      onAnnounce("Transcription terminée.");
    } else if (uploadQueue.globalStatus === "error") {
      onAnnounce("Certains passages n'ont pas pu être envoyés. Vérifie les erreurs affichées ci-dessous.");
    }
  }, [uploadQueue.globalStatus, onAnnounce]);

  return (
    <>
      <OfflineQueueBanner
        show={uploadQueue.globalStatus === "offline" && uploadQueue.pendingCount > 0}
      />
      <UploadProgress
        progress={uploadQueue.noteProgress}
        globalStatus={uploadQueue.globalStatus}
        onRetry={uploadQueue.retrySegment}
      />
    </>
  );
}
