"use client";

import { useEffect, useRef, useState } from "react";

import type { CreateAudioContextFn, GetUserMediaFn } from "@/hooks/useRecorder";
import { useRecorder } from "@/hooks/useRecorder";
import type { DocumentVisibilityLike, WakeLockLike } from "@/hooks/useWakeLock";
import { useWakeLock } from "@/hooks/useWakeLock";
import type { CreateMediaRecorderFn } from "@/lib/recorder/engine";
import type { IsTypeSupportedFn } from "@/lib/recorder/mime-types";
import { createIndexedDbNoteStore } from "@/lib/store/indexeddb";
import type { NoteStore } from "@/types/notes";

import {
  clearActiveRecordingMarker,
  readActiveRecordingMarker,
  writeActiveRecordingMarker,
} from "./activeRecordingMarker";
import ErrorBanner from "./ErrorBanner";
import { formatDuration } from "./format";
import LevelMeter from "./LevelMeter";
import PauseResumeButton from "./PauseResumeButton";
import RecordButton from "./RecordButton";
import ResumeNotice, { type ResumeNoticeInfo } from "./ResumeNotice";
import TimerDisplay from "./TimerDisplay";
import WakeLockBanner from "./WakeLockBanner";

export interface RecorderScreenProps {
  /** Injectable pour les tests ; par défaut la vraie base IndexedDB de production. */
  store?: NoteStore;
  /** Injectables pour les tests, transmis tels quels à `useRecorder`/`useWakeLock`. */
  getUserMedia?: GetUserMediaFn;
  isTypeSupported?: IsTypeSupportedFn;
  createMediaRecorder?: CreateMediaRecorderFn;
  createAudioContext?: CreateAudioContextFn;
  now?: () => number;
  /** Injectable pour les tests : `RECORDER_SEGMENT_MS` du contrat par défaut. */
  segmentMs?: number;
  /** Injectable pour les tests : `NOTE_MAX_DURATION_MS` du contrat par défaut. */
  maxDurationMs?: number;
  wakeLock?: WakeLockLike;
  documentRef?: DocumentVisibilityLike;
}

// Pas de sélecteur de langue dans ce ticket (hors périmètre de l'écran
// d'enregistrement) : "auto" est la valeur par défaut retenue par le contrat.
const DEFAULT_LANG = "auto" as const;

/**
 * Écran d'enregistrement — assemble useRecorder, useWakeLock et le NoteStore
 * IndexedDB déjà livrés. Ne contient aucune logique d'enregistrement propre :
 * uniquement de la présentation, du câblage d'état, et la détection d'une
 * note laissée active par une session précédente (voir activeRecordingMarker.ts).
 */
export default function RecorderScreen(props: RecorderScreenProps) {
  const [fallbackStore] = useState<NoteStore>(() => props.store ?? createIndexedDbNoteStore());
  const store = props.store ?? fallbackStore;

  const recorder = useRecorder({
    store,
    getUserMedia: props.getUserMedia,
    isTypeSupported: props.isTypeSupported,
    createMediaRecorder: props.createMediaRecorder,
    createAudioContext: props.createAudioContext,
    now: props.now,
    segmentMs: props.segmentMs,
    maxDurationMs: props.maxDurationMs,
  });
  const wakeLock = useWakeLock({ wakeLock: props.wakeLock, documentRef: props.documentRef });

  const [announcement, setAnnouncement] = useState("");
  const [interruptedNote, setInterruptedNote] = useState<ResumeNoticeInfo | null>(null);
  const previousStateRef = useRef(recorder.state);
  const previousSegmentCountRef = useRef(recorder.segmentCount);

  // Détection, au montage seulement, d'une note laissée active par une
  // session précédente (refresh, crash, onglet fermé). Voir le commentaire
  // en tête d'activeRecordingMarker.ts pour l'argumentaire complet : le
  // NoteStore seul ne permet pas de distinguer un arrêt propre d'un
  // abandon, donc on s'appuie sur un marqueur posé/effacé côté client par
  // cet écran lui-même.
  useEffect(() => {
    let cancelled = false;
    async function checkForInterruptedNote() {
      const marker = readActiveRecordingMarker();
      if (!marker) return;
      const [note, segments] = await Promise.all([
        store.getNote(marker.noteId),
        store.listSegments(marker.noteId),
      ]);
      if (cancelled) return;
      if (!note || segments.length === 0) {
        // Note disparue, ou jamais eu de segment fermé : rien à récupérer.
        clearActiveRecordingMarker();
        return;
      }
      setInterruptedNote({
        noteId: note.id,
        createdAt: note.createdAt,
        segmentCount: segments.length,
        durationMs: note.durationMs,
      });
    }
    void checkForInterruptedNote();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- volontairement une seule fois au montage : reprise après rechargement, pas un état à revalider en continu
  }, []);

  // Marqueur de session active + wake lock, câblés sur les transitions de la
  // machine à états exposée par useRecorder.
  useEffect(() => {
    const previous = previousStateRef.current;
    previousStateRef.current = recorder.state;
    if (previous === recorder.state) return;

    if (recorder.state === "recording") {
      if (recorder.noteId) writeActiveRecordingMarker(recorder.noteId);
      void wakeLock.request();
      setAnnouncement(previous === "paused" ? "Enregistrement repris." : "Enregistrement démarré.");
    } else if (recorder.state === "paused") {
      setAnnouncement(
        `Enregistrement en pause. Durée enregistrée : ${formatDuration(recorder.elapsedMs)}.`,
      );
    } else if (recorder.state === "stopped") {
      clearActiveRecordingMarker();
      void wakeLock.release();
      const plural = recorder.segmentCount > 1;
      setAnnouncement(
        `Enregistrement arrêté. Durée totale : ${formatDuration(recorder.elapsedMs)}, ${recorder.segmentCount} segment${plural ? "s" : ""} sauvegardé${plural ? "s" : ""}.`,
      );
    } else if (recorder.state === "error") {
      void wakeLock.release();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ne doit se déclencher qu'aux transitions de `state`, pas à chaque changement de noteId/elapsedMs/segmentCount qui l'accompagnent déjà
  }, [recorder.state]);

  // Nombre de segments sauvegardés : annoncé séparément du minuteur (qui, lui,
  // ne doit jamais passer par aria-live — voir TimerDisplay).
  useEffect(() => {
    const previous = previousSegmentCountRef.current;
    previousSegmentCountRef.current = recorder.segmentCount;
    if (recorder.segmentCount > previous) {
      const plural = recorder.segmentCount > 1;
      setAnnouncement(
        `${recorder.segmentCount} segment${plural ? "s" : ""} enregistré${plural ? "s" : ""} et sauvegardé${plural ? "s" : ""}.`,
      );
    }
  }, [recorder.segmentCount]);

  function handleStart() {
    setInterruptedNote(null);
    recorder.start(DEFAULT_LANG).catch(() => {
      // Déjà reflété dans errorMessage/state par le hook ; rien de plus ici.
    });
  }

  // Reprend réellement la note interrompue détectée au montage : le hook
  // relit ses segments existants et poursuit la numérotation, sans rien
  // recréer (voir ResumeNotice). `lang` est ignoré par le hook dès qu'un
  // `noteId` est fourni — "auto" n'est là que comme valeur neutre du
  // paramètre. Si la note a disparu entre-temps, le hook rejette avec le
  // code `note-not-found` : on l'affiche comme n'importe quelle autre erreur
  // (voir ErrorBanner) plutôt que de la traiter spécialement.
  function handleResumeInterruptedNote(noteId: string) {
    setInterruptedNote(null);
    recorder.start(DEFAULT_LANG, { noteId }).catch(() => {
      // Déjà reflété dans errorMessage/errorCode par le hook.
    });
  }

  function handleStop() {
    recorder.stop().catch(() => {});
  }

  function handlePause() {
    recorder.pause().catch(() => {});
  }

  function handleResume() {
    recorder.resume().catch(() => {});
  }

  function handleFinishInterrupted() {
    clearActiveRecordingMarker();
    setInterruptedNote(null);
  }

  const isSessionActive = recorder.state === "recording" || recorder.state === "paused";
  const showWakeLockBanner =
    isSessionActive && (wakeLock.status === "unsupported" || wakeLock.status === "error");
  const showSegmentStatus = recorder.state !== "idle";
  const segmentsPlural = recorder.segmentCount > 1;

  return (
    <div className="flex w-full flex-col items-center gap-6 px-6">
      {/* Annonces d'état pour lecteur d'écran : jamais le tick du minuteur. */}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {interruptedNote && (
        <ResumeNotice
          note={interruptedNote}
          onResume={() => handleResumeInterruptedNote(interruptedNote.noteId)}
          onFinish={handleFinishInterrupted}
        />
      )}

      <ErrorBanner message={recorder.errorMessage} code={recorder.errorCode} onRetry={handleStart} />

      <WakeLockBanner show={showWakeLockBanner} />

      <RecordButton
        state={recorder.state}
        disabled={!recorder.mimeTypeSupported}
        onStart={handleStart}
        onStop={handleStop}
      />

      {isSessionActive && (
        <PauseResumeButton state={recorder.state} onPause={handlePause} onResume={handleResume} />
      )}

      <TimerDisplay elapsedMs={recorder.elapsedMs} state={recorder.state} />

      <LevelMeter level={recorder.level} />

      {showSegmentStatus && (
        <p data-testid="segment-status" className="text-sm text-slate-400">
          {recorder.segmentCount} segment{segmentsPlural ? "s" : ""} enregistré
          {segmentsPlural ? "s" : ""} et sauvegardé{segmentsPlural ? "s" : ""}.
        </p>
      )}
    </div>
  );
}
