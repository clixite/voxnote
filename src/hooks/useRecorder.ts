"use client";

/**
 * Hook d'enregistrement vocal. Toute la logique de segmentation vit dans
 * `RecorderEngine` (src/lib/recorder/engine.ts), testable sans React : ce
 * hook se contente de gérer le cycle de vie React (`getUserMedia`, montage/
 * démontage, VU-mètre) et d'exposer un état simple à l'UI.
 *
 * Le hook ne dépend que de l'interface `NoteStore` (src/types/notes.ts),
 * jamais d'une implémentation concrète — elle est développée en parallèle.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { RecorderState } from "@/lib/recorder/machine";
import {
  RecorderEngine,
  type CreateMediaRecorderFn,
  type RecorderEngineSnapshot,
} from "@/lib/recorder/engine";
import { RecorderError, toRecorderError } from "@/lib/recorder/errors";
import { pickSupportedMimeType, type IsTypeSupportedFn } from "@/lib/recorder/mime-types";
import { computeNormalizedLevel } from "@/lib/recorder/vu-meter";
import type { LangSetting, NoteStore } from "@/types/notes";

export type GetUserMediaFn = (constraints: MediaStreamConstraints) => Promise<MediaStream>;
export type CreateAudioContextFn = () => AudioContext;

export interface UseRecorderOptions {
  store: NoteStore;
  segmentMs?: number;
  maxDurationMs?: number;
  /** Injectables pour les tests ; par défaut les API navigateur réelles. */
  getUserMedia?: GetUserMediaFn;
  isTypeSupported?: IsTypeSupportedFn;
  createMediaRecorder?: CreateMediaRecorderFn;
  createAudioContext?: CreateAudioContextFn;
  now?: () => number;
}

export interface UseRecorderResult {
  state: RecorderState;
  noteId: string | undefined;
  /** Nombre de segments déjà fermés et persistés. */
  segmentCount: number;
  /** Durée cumulée hors pause, en millisecondes. */
  elapsedMs: number;
  /** Message d'erreur en français, prêt à afficher tel quel. */
  errorMessage: string | undefined;
  /** `false` si aucun mimeType audio n'est supporté par ce navigateur. */
  mimeTypeSupported: boolean;
  /** Niveau sonore normalisé (0..1) pour un VU-mètre ; 0 si non disponible. */
  level: number;
  start: (lang: LangSetting) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  /**
   * À appeler depuis un geste utilisateur si l'`AudioContext` reste suspendu
   * (piège iOS documenté dans la skill audio-web) : `start()` tente déjà un
   * `resume()`, ce bouton de secours couvre les cas où ce n'est pas suffisant.
   */
  resumeAudioContext: () => Promise<void>;
}

const EMPTY_SNAPSHOT: RecorderEngineSnapshot = { state: "idle", segmentCount: 0, elapsedMs: 0 };

function defaultGetUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia(constraints);
}

function defaultIsTypeSupported(type: string): boolean {
  return MediaRecorder.isTypeSupported(type);
}

export function useRecorder(options: UseRecorderOptions): UseRecorderResult {
  const { store } = options;

  const engineRef = useRef<RecorderEngine | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  const [noteId, setNoteId] = useState<string | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<RecorderEngineSnapshot>(EMPTY_SNAPSHOT);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [mimeTypeSupported, setMimeTypeSupported] = useState(true);
  const [level, setLevel] = useState(0);

  const getUserMedia = useMemo<GetUserMediaFn>(
    () => options.getUserMedia ?? defaultGetUserMedia,
    [options.getUserMedia],
  );
  const isTypeSupported = useMemo<IsTypeSupportedFn>(
    () => options.isTypeSupported ?? defaultIsTypeSupported,
    [options.isTypeSupported],
  );

  const stopVuMeter = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    analyserRef.current = null;
    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    setLevel(0);
    if (ctx) void ctx.close().catch(() => {});
  }, []);

  const startVuMeter = useCallback(
    async (stream: MediaStream) => {
      const createAudioContext =
        options.createAudioContext ??
        (typeof AudioContext !== "undefined" ? () => new AudioContext() : undefined);
      if (!createAudioContext) return; // VU-mètre indisponible : dégradation silencieuse, hors périmètre bloquant

      try {
        const ctx = createAudioContext();
        audioContextRef.current = ctx;
        if (ctx.state === "suspended") {
          // Piège iOS (skill audio-web) : resume() doit suivre un geste
          // utilisateur. start() est lui-même déclenché par un tap, donc on
          // tente ici ; un échec (activation déjà "consommée" par l'attente de
          // getUserMedia sur certains Safari) n'est vérifiable que sur device
          // réel, pas reproductible en jsdom — voir resumeAudioContext().
          await ctx.resume().catch(() => {});
        }
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        analyserRef.current = analyser;

        const data = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          setLevel(computeNormalizedLevel(data));
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        // Le VU-mètre est un bonus visuel : son échec ne doit jamais bloquer l'enregistrement.
      }
    },
    [options.createAudioContext],
  );

  const resumeAudioContext = useCallback(async () => {
    const ctx = audioContextRef.current;
    if (ctx && ctx.state === "suspended") {
      await ctx.resume().catch(() => {});
    }
  }, []);

  const teardownStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(
    async (lang: LangSetting) => {
      setErrorMessage(undefined);
      setMimeTypeSupported(true);

      // Vérifié avant toute demande de permission : inutile de faire prompter
      // le micro sur un navigateur qui ne pourra de toute façon rien enregistrer.
      const mimeType = pickSupportedMimeType(isTypeSupported);
      if (!mimeType) {
        setMimeTypeSupported(false);
        setSnapshot((s) => ({ ...s, state: "error" }));
        const err = new RecorderError(
          "no-supported-mime-type",
          "Ce navigateur ne permet pas d'enregistrer de l'audio ici. Essayez avec une version à jour de Chrome, Safari ou Firefox.",
        );
        setErrorMessage(err.message);
        throw err;
      }

      let stream: MediaStream;
      try {
        stream = await getUserMedia({ audio: true });
      } catch (rawError) {
        const err = toRecorderError(rawError);
        setSnapshot((s) => ({ ...s, state: "error" }));
        setErrorMessage(err.message);
        throw err;
      }
      streamRef.current = stream;

      const note = await store.createNote({ lang });
      setNoteId(note.id);

      const engine = new RecorderEngine({
        store,
        noteId: note.id,
        stream,
        mimeType,
        segmentMs: options.segmentMs,
        maxDurationMs: options.maxDurationMs,
        isTypeSupported,
        createMediaRecorder: options.createMediaRecorder,
        now: options.now,
      });
      engineRef.current = engine;
      engine.subscribe((next) => {
        setSnapshot(next);
        if (next.error) setErrorMessage(next.error.message);
      });

      try {
        await engine.start();
      } catch (rawError) {
        teardownStream();
        await store.deleteNote(note.id).catch(() => {});
        const err = rawError instanceof RecorderError ? rawError : toRecorderError(rawError);
        setErrorMessage(err.message);
        throw err;
      }

      void startVuMeter(stream);
    },
    [
      getUserMedia,
      isTypeSupported,
      store,
      options.segmentMs,
      options.maxDurationMs,
      options.createMediaRecorder,
      options.now,
      startVuMeter,
      teardownStream,
    ],
  );

  const pause = useCallback(async () => {
    await engineRef.current?.pause();
  }, []);

  const resume = useCallback(async () => {
    await engineRef.current?.resume();
  }, []);

  const stop = useCallback(async () => {
    await engineRef.current?.stop();
    teardownStream();
    stopVuMeter();
  }, [teardownStream, stopVuMeter]);

  useEffect(() => {
    return () => {
      engineRef.current?.dispose();
      teardownStream();
      stopVuMeter();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nettoyage au démontage uniquement
  }, []);

  return {
    state: snapshot.state,
    noteId,
    segmentCount: snapshot.segmentCount,
    elapsedMs: snapshot.elapsedMs,
    errorMessage,
    mimeTypeSupported,
    level,
    start,
    pause,
    resume,
    stop,
    resumeAudioContext,
  };
}
