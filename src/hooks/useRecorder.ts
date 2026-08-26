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
import {
  noSupportedMimeTypeError,
  noteNotFoundError,
  RecorderError,
  toRecorderError,
  type RecorderErrorCode,
} from "@/lib/recorder/errors";
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

export interface StartRecordingOptions {
  /**
   * Reprend une note existante (déjà connue du `NoteStore`, avec ses
   * segments déjà persistés — typiquement après un refresh en cours
   * d'enregistrement) plutôt que d'en créer une nouvelle. `lang` est alors
   * ignoré : la note conserve la langue choisie à sa création. La numérotation
   * des segments et la durée cumulée repartent de l'existant, jamais de zéro
   * (voir `RecorderEngine.start`).
   *
   * Trouver le `noteId` à reprendre est hors du périmètre de ce hook, qui ne
   * dépend que de l'interface `NoteStore` : l'appelant (l'écran d'enregistrement)
   * garde son propre marqueur de session active et lit le `NoteStore`
   * directement pour retrouver la note interrompue et ses segments.
   */
  noteId?: string;
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
  /**
   * Code discriminant de la dernière erreur, à côté du message français :
   * permet à l'UI d'afficher un conseil spécifique (ex. « aucun micro » vs
   * « permission refusée ») sans analyser le texte du message.
   */
  errorCode: RecorderErrorCode | undefined;
  /** `false` si aucun mimeType audio n'est supporté par ce navigateur. */
  mimeTypeSupported: boolean;
  /** Niveau sonore normalisé (0..1) pour un VU-mètre ; 0 si non disponible. */
  level: number;
  /**
   * Démarre un enregistrement. `lang` sert à créer une nouvelle note ; passer
   * `{ noteId }` reprend une note existante à la place (voir `StartRecordingOptions`).
   */
  start: (lang: LangSetting, options?: StartRecordingOptions) => Promise<void>;
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
  const [errorCode, setErrorCode] = useState<RecorderErrorCode | undefined>(undefined);
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
    // Pas de setLevel(0) ici : cette fonction est appelée depuis un effet
    // (état terminal, voir plus bas), et déclencher un setState synchrone
    // depuis un effet est ce que `react-hooks/set-state-in-effect` signale à
    // raison. Le niveau affiché à 0 en fin de vie est dérivé plus bas à
    // partir de `snapshot.state` à la place — même résultat, sans render en
    // cascade.
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
    async (lang: LangSetting, startOptions: StartRecordingOptions = {}) => {
      // Défensif, avant tout le reste : si un stream ou un AudioContext
      // précédent traîne encore (ex. un appui sur "Réessayer" juste après une
      // erreur), on ne les écrase jamais sans les arrêter d'abord — sinon
      // leur micro reste ouvert indéfiniment, le premier devenant impossible
      // à arrêter (BLOQUANT B2 de la revue d'architecture).
      teardownStream();
      stopVuMeter();

      setErrorMessage(undefined);
      setErrorCode(undefined);
      setMimeTypeSupported(true);

      // Vérifié avant toute demande de permission : inutile de faire prompter
      // le micro sur un navigateur qui ne pourra de toute façon rien enregistrer.
      const mimeType = pickSupportedMimeType(isTypeSupported);
      if (!mimeType) {
        setMimeTypeSupported(false);
        setSnapshot((s) => ({ ...s, state: "error" }));
        const err = noSupportedMimeTypeError();
        setErrorMessage(err.message);
        setErrorCode(err.code);
        throw err;
      }

      // Reprise d'une note existante : vérifiée avant la permission micro elle
      // aussi, pour la même raison (RecorderEngine.start() revalide de toute
      // façon, utile à qui instancie le moteur directement hors du hook).
      if (startOptions.noteId) {
        const existing = await store.getNote(startOptions.noteId);
        if (!existing) {
          setSnapshot((s) => ({ ...s, state: "error" }));
          const err = noteNotFoundError();
          setErrorMessage(err.message);
          setErrorCode(err.code);
          throw err;
        }
      }

      let stream: MediaStream;
      try {
        stream = await getUserMedia({ audio: true });
      } catch (rawError) {
        const err = toRecorderError(rawError);
        setSnapshot((s) => ({ ...s, state: "error" }));
        setErrorMessage(err.message);
        setErrorCode(err.code);
        throw err;
      }
      streamRef.current = stream;

      let recordingNoteId: string;
      if (startOptions.noteId) {
        recordingNoteId = startOptions.noteId;
      } else {
        const note = await store.createNote({ lang });
        recordingNoteId = note.id;
      }
      setNoteId(recordingNoteId);

      const engine = new RecorderEngine({
        store,
        noteId: recordingNoteId,
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
        if (next.error) {
          setErrorMessage(next.error.message);
          setErrorCode(next.error.code);
        }
      });

      try {
        await engine.start();
      } catch (rawError) {
        teardownStream();
        // Une note REPRISE préexistante ne doit jamais être supprimée sur un
        // échec de démarrage : ses segments d'avant le refresh doivent
        // survivre. On ne supprime que la note qu'on vient de créer ici même.
        if (!startOptions.noteId) {
          await store.deleteNote(recordingNoteId).catch(() => {});
        }
        const err = rawError instanceof RecorderError ? rawError : toRecorderError(rawError);
        setErrorMessage(err.message);
        setErrorCode(err.code);
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
      stopVuMeter,
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
    // Le nettoyage (stream, VU-mètre) n'est plus un effet de bord de cet
    // appel : voir l'effet ci-dessous, qui réagit à l'état terminal quelle
    // qu'en soit l'origine (BLOQUANT B2). Un stop() manuel y mène comme les
    // autres, donc reste couvert.
    await engineRef.current?.stop();
  }, []);

  // BLOQUANT B2 (revue d'architecture) : trois chemins sur quatre menaient à
  // `stopped`/`error` sans jamais relâcher le stream ni le VU-mètre, parce que
  // teardownStream()/stopVuMeter() n'étaient appelés que dans stop() —
  // jamais quand le moteur bascule de sa propre initiative (plafond de 2h via
  // finishOnCap, échec de beginCycle, échec d'écriture B1/B3). En réagissant
  // à l'état terminal plutôt qu'au clic, les quatre chemins sont couverts par
  // le même code. teardownStream()/stopVuMeter() sont idempotents : les
  // rappeler après un stop() manuel (qui a déjà tout relâché en amenant l'état
  // ici) ne fait rien de plus.
  useEffect(() => {
    if (snapshot.state === "stopped" || snapshot.state === "error") {
      teardownStream();
      stopVuMeter();
    }
  }, [snapshot.state, teardownStream, stopVuMeter]);

  useEffect(() => {
    return () => {
      engineRef.current?.dispose();
      teardownStream();
      stopVuMeter();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nettoyage au démontage uniquement
  }, []);

  // Dérivé plutôt qu'imposé par un setState dans l'effet de nettoyage
  // ci-dessus : le niveau affiché retombe à 0 dès que l'état est terminal,
  // que la boucle d'animation ait déjà eu le temps de tourner une dernière
  // fois ou non.
  const isTerminal = snapshot.state === "stopped" || snapshot.state === "error";

  return {
    state: snapshot.state,
    noteId,
    segmentCount: snapshot.segmentCount,
    elapsedMs: snapshot.elapsedMs,
    errorMessage,
    errorCode,
    mimeTypeSupported,
    level: isTerminal ? 0 : level,
    start,
    pause,
    resume,
    stop,
    resumeAudioContext,
  };
}
