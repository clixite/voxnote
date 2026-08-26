"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { CreateAudioContextFn, GetUserMediaFn } from "@/hooks/useRecorder";
import { useRecorder } from "@/hooks/useRecorder";
import type { WindowOnlineLike } from "@/hooks/useUploadQueue";
import type { DocumentVisibilityLike, WakeLockLike } from "@/hooks/useWakeLock";
import { useWakeLock } from "@/hooks/useWakeLock";
import type { CreateMediaRecorderFn } from "@/lib/recorder/engine";
import type { IsTypeSupportedFn } from "@/lib/recorder/mime-types";
import { createIndexedDbNoteStore } from "@/lib/store/indexeddb";
import type { TranscribeSegmentFn, UploadSegmentFn } from "@/lib/upload/queue";
import type { NoteStore } from "@/types/notes";

import {
  clearActiveRecordingMarker,
  HEARTBEAT_INTERVAL_MS,
  isMarkerStale,
  isOwnMarker,
  readActiveRecordingMarker,
  writeActiveRecordingMarker,
} from "./activeRecordingMarker";
import { createDeleteNote, type DeleteNoteFn } from "./deleteNote";
import DeleteNoteAction from "./DeleteNoteAction";
import ErrorBanner from "./ErrorBanner";
import { formatDuration } from "./format";
import LevelMeter from "./LevelMeter";
import OtherTabNotice from "./OtherTabNotice";
import PauseResumeButton from "./PauseResumeButton";
import RecordButton from "./RecordButton";
import ResumeNotice, { type ResumeNoticeInfo } from "./ResumeNotice";
import TimerDisplay from "./TimerDisplay";
import UploadQueueSection from "./UploadQueueSection";
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
  /** Injectables pour les tests, transmis tels quels à `useUploadQueue` (via UploadQueueSection). */
  uploadSegment?: UploadSegmentFn;
  transcribeSegment?: TranscribeSegmentFn;
  uploadConcurrency?: number;
  isOnline?: () => boolean;
  windowRef?: WindowOnlineLike;
  /** Injectable pour les tests ; en production, `createDeleteNote(store)`. */
  deleteNote?: DeleteNoteFn;
}

// Pas de sélecteur de langue dans ce ticket (hors périmètre de l'écran
// d'enregistrement) : "auto" est la valeur par défaut retenue par le contrat.
const DEFAULT_LANG = "auto" as const;

/**
 * Écran d'enregistrement — assemble useRecorder, useWakeLock, UploadQueueSection
 * et le NoteStore IndexedDB déjà livrés. Ne contient aucune logique
 * d'enregistrement propre : uniquement de la présentation, du câblage
 * d'état, et la détection d'une note laissée active par une session
 * précédente (voir activeRecordingMarker.ts).
 */
export default function RecorderScreen(props: RecorderScreenProps) {
  const [fallbackStore] = useState<NoteStore>(() => props.store ?? createIndexedDbNoteStore());
  const store = props.store ?? fallbackStore;
  const deleteNoteFn = useMemo(
    () => props.deleteNote ?? createDeleteNote(store),
    [props.deleteNote, store],
  );

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
  const [recordingElsewhere, setRecordingElsewhere] = useState<{
    noteId: string;
    createdAt: number;
  } | null>(null);
  // `undefined` tant que la vérification initiale (marqueur + store) n'a pas
  // tranché : la file d'upload ne doit monter qu'une fois cette réponse
  // connue (voir plus bas), jamais avant — sans quoi elle démarrerait sur
  // TOUS les segments en attente, y compris ceux d'une note qu'un autre
  // onglet vivant est en train d'enregistrer, avant même d'avoir eu la
  // chance de le détecter (B2).
  const [markerCheckDone, setMarkerCheckDone] = useState(false);
  // Note dont on affiche la progression d'envoi quand cet écran n'est PAS en
  // train d'enregistrer lui-même (voir le signalement QA : après une
  // navigation incidente — reconnexion réseau qui relance un prefetch en
  // attente — `recorder.noteId` d'une note déjà arrêtée redevient
  // `undefined`, sans que rien d'autre ne le remplace).
  const [pendingNoteId, setPendingNoteId] = useState<string | undefined>(undefined);
  const previousStateRef = useRef(recorder.state);
  const previousSegmentCountRef = useRef(recorder.segmentCount);

  // Détection, au montage seulement, d'une note laissée active par une
  // session précédente (refresh, crash, onglet fermé, ou un AUTRE onglet).
  // Voir le commentaire en tête d'activeRecordingMarker.ts pour
  // l'argumentaire complet : le NoteStore seul ne permet pas de distinguer
  // un arrêt propre d'un abandon, donc on s'appuie sur un marqueur
  // posé/rafraîchi/effacé côté client par cet écran lui-même.
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
      if (!note) {
        // Note disparue entre-temps (ex. purge) : plus rien à signaler.
        clearActiveRecordingMarker();
        return;
      }
      // Priorité absolue à cette garde, AVANT tout traitement destructeur
      // (voir S3 ci-dessous) : un marqueur frais d'un AUTRE onglet doit
      // court-circuiter toute action, y compris la suppression de coquille
      // vide. Sans cette priorité, un onglet qui vient de démarrer un
      // enregistrement — donc sans le moindre segment fermé pendant ses
      // cinq premières minutes, la durée d'un cycle — se ferait voir comme
      // une coquille vide et supprimer par n'importe quel autre onglet
      // monté entre-temps : perte totale de l'audio en cours, pire que la
      // collision de `seq` que ce marqueur visait justement à éviter (B4).
      // Un marqueur périmé (onglet mort) ou posé par CET onglet (refresh du
      // même onglet, cas nominal) retombe dans les cas normaux ci-dessous.
      if (!isOwnMarker(marker) && !isMarkerStale(marker)) {
        setRecordingElsewhere({ noteId: note.id, createdAt: note.createdAt });
        return;
      }
      if (segments.length === 0) {
        // Crash avant le moindre segment fermé (S3) : il n'y a rien à
        // reprendre, et un bandeau qui proposerait de récupérer le néant
        // serait pire que pas de bandeau. On supprime silencieusement
        // plutôt que de laisser une coquille vide traîner dans le store —
        // elle apparaîtrait sinon indéfiniment dans la future liste de notes.
        // Atteint seulement pour un marqueur périmé ou propre à cet onglet :
        // jamais pour un autre onglet encore vivant (garde ci-dessus).
        clearActiveRecordingMarker();
        await store.deleteNote(note.id).catch(() => {});
        return;
      }
      setInterruptedNote({
        noteId: note.id,
        createdAt: note.createdAt,
        segmentCount: segments.length,
        durationMs: note.durationMs,
      });
    }
    void checkForInterruptedNote().finally(() => {
      if (!cancelled) setMarkerCheckDone(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- volontairement une seule fois au montage : reprise après rechargement, pas un état à revalider en continu
  }, []);

  // Retrouve, au montage, la note à suivre pour la progression d'envoi
  // quand cet écran ne vient pas de démarrer sa propre session
  // d'enregistrement (`recorder.noteId` reste `undefined` dans ce cas — voir
  // plus bas). Signalement QA : sans ceci, une note fraîchement arrêtée dont
  // les segments continuent d'être envoyés en arrière-plan perd tout
  // affichage de suivi après un rechargement — y compris un rechargement
  // provoqué par le navigateur lui-même (reprise de prefetch au retour
  // réseau), pas seulement un F5 volontaire. Rien n'est perdu côté données
  // (IndexedDB atteint bien l'état terminé), seul l'affichage disparaissait.
  useEffect(() => {
    let cancelled = false;
    store
      .listPendingSegments()
      .then((segments) => {
        if (cancelled) return;
        const [oldest] = segments;
        if (oldest) setPendingNoteId(oldest.noteId);
      })
      .catch(() => {
        // Pas de quoi bloquer l'écran : au pire, aucune progression ne
        // s'affiche tant qu'un nouveau segment ne réveille pas la file.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- volontairement une seule fois au montage, comme la détection de reprise ci-dessus
  }, []);

  // Re-vérifie périodiquement qu'un « autre onglet » signalé l'est toujours :
  // sans ceci, une fois `recordingElsewhere` posé, ni le bandeau ni la file
  // d'upload (voir plus bas) ne se rétabliraient jamais sur cette page tant
  // qu'elle reste ouverte, même longtemps après que l'autre onglet a
  // terminé ou est mort. Même cadence que le heartbeat, pour rester cohérent
  // avec le seuil de péremption (voir activeRecordingMarker.ts).
  useEffect(() => {
    if (!recordingElsewhere) return;
    const id = setInterval(() => {
      const marker = readActiveRecordingMarker();
      const stillOwnedElsewhere =
        marker !== undefined &&
        marker.noteId === recordingElsewhere.noteId &&
        !isOwnMarker(marker) &&
        !isMarkerStale(marker);
      if (!stillOwnedElsewhere) setRecordingElsewhere(null);
    }, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [recordingElsewhere]);

  // Heartbeat : rafraîchit `updatedAt` pendant toute la durée de la session
  // (recording ET paused — un autre onglet ne doit pas croire cette note
  // abandonnée pendant une pause), pour que la détection ci-dessus distingue
  // un autre onglet vivant d'un autre onglet mort. Voir activeRecordingMarker.ts
  // pour la justification des seuils.
  useEffect(() => {
    const sessionActive = recorder.state === "recording" || recorder.state === "paused";
    if (!sessionActive) return;
    const activeNoteId = recorder.noteId;
    if (!activeNoteId) return;
    const id = setInterval(() => {
      writeActiveRecordingMarker(activeNoteId);
    }, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [recorder.state, recorder.noteId]);

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
      // Bascule explicite "recording" -> "processing" : c'est le seul
      // moment où l'écran d'enregistrement sait que la session est
      // réellement terminée. La file d'upload (UploadQueueSection) prend le
      // relais à partir de là pour dériver "done"/"partial"/"error" au fil
      // des segments — voir le commentaire de tête de lib/upload/noteRollup.ts.
      if (recorder.noteId) {
        void store.updateNote(recorder.noteId, { status: "processing" }).catch(() => {});
      }
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

  function handleNoteDeleted(deletedNoteId: string) {
    setPendingNoteId((current) => (current === deletedNoteId ? undefined : current));
    setInterruptedNote((current) => (current?.noteId === deletedNoteId ? null : current));
    const marker = readActiveRecordingMarker();
    if (marker?.noteId === deletedNoteId) clearActiveRecordingMarker();
    setAnnouncement("Note supprimée.");
  }

  const isSessionActive = recorder.state === "recording" || recorder.state === "paused";
  const showWakeLockBanner =
    isSessionActive && (wakeLock.status === "unsupported" || wakeLock.status === "error");
  const showSegmentStatus = recorder.state !== "idle";
  const segmentsPlural = recorder.segmentCount > 1;

  // Note dont la progression d'envoi est affichée : la session active en
  // cours si elle existe, sinon la dernière note retrouvée avec des
  // segments en attente (voir l'effet ci-dessus).
  const trackedNoteId = recorder.noteId ?? pendingNoteId;
  // B2 : ne monte la file d'upload que lorsque la vérification initiale a
  // tranché ET qu'aucun autre onglet vivant ne détient la note affichée.
  // Tant que `recordingElsewhere` est vrai, ce composant reste démonté :
  // c'est ce qui coupe réellement le traitement (pas seulement son
  // affichage), voir UploadQueueSection. Effet de bord accepté et documenté
  // au rapport : cela met aussi en pause l'envoi d'éventuelles AUTRES notes
  // de cet onglet le temps que la situation se résolve, faute de pouvoir
  // demander à la file de ne traiter qu'un sous-ensemble de notes depuis ce
  // seul composant (voir UploadQueueSection, hors périmètre de ce ticket).
  const showUploadQueue = markerCheckDone && !recordingElsewhere;
  // Supprimer suppose une note bien identifiée, hors session active (on ne
  // supprime pas ce qu'on est en train d'enregistrer) et jamais une note
  // qu'un autre onglet vivant détient encore.
  const showDeleteAction = Boolean(trackedNoteId) && !isSessionActive && !recordingElsewhere;

  return (
    <div className="flex w-full flex-col items-center gap-6 px-6">
      {/* Annonces d'état pour lecteur d'écran : jamais le tick du minuteur. */}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {recordingElsewhere && <OtherTabNotice createdAt={recordingElsewhere.createdAt} />}

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

      {showUploadQueue && (
        <UploadQueueSection
          store={store}
          noteId={trackedNoteId}
          segmentCount={recorder.segmentCount}
          onAnnounce={setAnnouncement}
          uploadSegment={props.uploadSegment}
          transcribeSegment={props.transcribeSegment}
          concurrency={props.uploadConcurrency}
          isOnline={props.isOnline}
          windowRef={props.windowRef}
        />
      )}

      {showDeleteAction && trackedNoteId && (
        <DeleteNoteAction noteId={trackedNoteId} onDelete={deleteNoteFn} onDeleted={handleNoteDeleted} />
      )}
    </div>
  );
}
