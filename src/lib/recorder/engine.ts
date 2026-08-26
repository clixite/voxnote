/**
 * Moteur de segmentation de l'enregistrement, sans dépendance à React.
 *
 * Décision structurante (docs/ARCHITECTURE.md, section « Segmentation ») :
 * on NE PASSE PAS de `timeslice` à `MediaRecorder.start()` pour produire les
 * segments. Seul le premier morceau émis par un `MediaRecorder` porte l'en-tête
 * du conteneur ; les morceaux suivants ne sont pas décodables isolément, ce qui
 * ferait rejeter tous les segments sauf le premier par les providers de
 * transcription. On découpe donc en ARRÊTANT ET REDÉMARRANT le
 * `MediaRecorder` toutes les `segmentMs`, sur le même `MediaStream` (la piste
 * micro reste ouverte : aucun nouveau prompt de permission). Chaque cycle
 * produit un fichier complet et autonome.
 *
 * Un `timeslice` court (`INTERNAL_TIMESLICE_MS`) reste utilisé À L'INTÉRIEUR
 * d'un cycle, uniquement pour récupérer les données au fil de l'eau et limiter
 * la perte si l'onglet meurt en cours de segment — ces morceaux intermédiaires
 * ne sont jamais persistés séparément, ils sont concaténés en un seul Blob à
 * la fermeture du segment.
 *
 * Zéro perte : chaque segment fermé est écrit dans le `NoteStore` AVANT toute
 * autre chose (avant même de démarrer le cycle suivant). Un crash ne coûte
 * donc au pire que le segment en cours.
 */
import {
  NOTE_MAX_DURATION_MS,
  RECORDER_SEGMENT_MS,
  type NoteStore,
} from "@/types/notes";

import {
  maxDurationReachedError,
  messageFor,
  noSupportedMimeTypeError,
  noteNotFoundError,
  RecorderError,
} from "./errors";
import { transition, type RecorderState } from "./machine";
import { pickSupportedMimeType, type IsTypeSupportedFn } from "./mime-types";

/** Timeslice interne au cycle : ne produit jamais de segment, seulement un filet de sécurité. */
const INTERNAL_TIMESLICE_MS = 1000;

export type CreateMediaRecorderFn = (
  stream: MediaStream,
  options: MediaRecorderOptions,
) => MediaRecorder;

export interface RecorderEngineOptions {
  store: NoteStore;
  noteId: string;
  stream: MediaStream;
  /** Durée visée d'un segment. Défaut : `RECORDER_SEGMENT_MS` du contrat. */
  segmentMs?: number;
  /** Plafond de durée totale. Défaut : `NOTE_MAX_DURATION_MS` du contrat. */
  maxDurationMs?: number;
  /** mimeType déjà résolu (évite une double détection si l'appelant l'a déjà fait). */
  mimeType?: string;
  isTypeSupported?: IsTypeSupportedFn;
  createMediaRecorder?: CreateMediaRecorderFn;
  /** Horloge injectable pour les tests. Défaut : `Date.now`. */
  now?: () => number;
}

export interface RecorderEngineSnapshot {
  state: RecorderState;
  /** Nombre de segments fermés et persistés (le segment en cours n'est pas compté). */
  segmentCount: number;
  /** Durée cumulée hors pause, en millisecondes, segment en cours inclus. */
  elapsedMs: number;
  error?: RecorderError;
}

export type RecorderEngineListener = (snapshot: RecorderEngineSnapshot) => void;

function defaultCreateMediaRecorder(
  stream: MediaStream,
  options: MediaRecorderOptions,
): MediaRecorder {
  return new MediaRecorder(stream, options);
}

export class RecorderEngine {
  private readonly store: NoteStore;
  private readonly noteId: string;
  private readonly stream: MediaStream;
  private readonly segmentMs: number;
  private readonly maxDurationMs: number;
  private readonly isTypeSupported: IsTypeSupportedFn;
  private readonly createMediaRecorder: CreateMediaRecorderFn;
  private readonly now: () => number;

  private state: RecorderState = "idle";
  private mimeType: string | undefined;
  private nextSeq = 0;
  private accumulatedMs = 0;
  private lastError: RecorderError | undefined;

  private currentRecorder: MediaRecorder | undefined;
  private cycleChunks: Blob[] = [];
  private cycleStartedAt = 0;
  private cappedThisCycle = false;
  private cycleTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly listeners = new Set<RecorderEngineListener>();
  /** File sérialisée : évite toute réentrance entre un appel manuel (pause/stop) et le minuteur. */
  private opQueue: Promise<unknown> = Promise.resolve();

  constructor(options: RecorderEngineOptions) {
    this.store = options.store;
    this.noteId = options.noteId;
    this.stream = options.stream;
    this.segmentMs = options.segmentMs ?? RECORDER_SEGMENT_MS;
    this.maxDurationMs = options.maxDurationMs ?? NOTE_MAX_DURATION_MS;
    this.mimeType = options.mimeType;
    this.isTypeSupported =
      options.isTypeSupported ?? ((type: string) => MediaRecorder.isTypeSupported(type));
    this.createMediaRecorder = options.createMediaRecorder ?? defaultCreateMediaRecorder;
    this.now = options.now ?? (() => Date.now());
  }

  getSnapshot(): RecorderEngineSnapshot {
    return this.buildSnapshot();
  }

  subscribe(listener: RecorderEngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Démarre l'enregistrement. Rejette avec une `RecorderError` française en
   * cas d'échec.
   *
   * Reprise d'une note existante : `noteId` (fixé à la construction) peut
   * désigner une note qui a déjà des segments persistés (ex. après un
   * refresh en cours d'enregistrement). Dans ce cas, la numérotation du
   * prochain segment et la durée cumulée sont TOUJOURS relues depuis le
   * `NoteStore` juste avant de démarrer — jamais déduites d'un compteur en
   * mémoire, qui vaudrait 0 pour un moteur fraîchement recréé après un
   * refresh. Pour une note tout juste créée, `listSegments` renvoie
   * simplement `[]` : le comportement de départ (seq 0, durée 0) est
   * inchangé.
   */
  start(): Promise<void> {
    return this.enqueue(async () => {
      // Validée avant tout effet de bord : un start() illégitime (déjà en
      // cours, déjà arrêté...) ne doit déclencher ni détection mimeType ni
      // lecture du store.
      const startedState = transition(this.state, "START");

      if (!this.mimeType) {
        const detected = pickSupportedMimeType(this.isTypeSupported);
        if (!detected) {
          this.state = transition(this.state, "ERROR");
          this.lastError = noSupportedMimeTypeError();
          this.emit();
          throw this.lastError;
        }
        this.mimeType = detected;
      }

      const note = await this.store.getNote(this.noteId);
      if (!note) {
        this.state = transition(this.state, "ERROR");
        this.lastError = noteNotFoundError();
        this.emit();
        throw this.lastError;
      }

      const existingSegments = await this.store.listSegments(this.noteId);
      this.nextSeq = existingSegments.reduce((max, s) => Math.max(max, s.seq + 1), 0);
      this.accumulatedMs = existingSegments.reduce((sum, s) => sum + s.durationMs, 0);

      this.state = startedState;
      this.lastError = undefined;
      this.emit();
      await this.beginCycle();
    });
  }

  /** Met en pause : ferme (et persiste) le segment en cours, ne perd rien. */
  pause(): Promise<void> {
    return this.enqueue(async () => {
      this.state = transition(this.state, "PAUSE");
      this.clearCycleTimer();
      await this.closeCurrentSegment();
      this.emit();
    });
  }

  /** Reprend : démarre un nouveau cycle de segment complet. */
  resume(): Promise<void> {
    return this.enqueue(async () => {
      this.state = transition(this.state, "RESUME");
      this.emit();
      await this.beginCycle();
    });
  }

  /** Arrête définitivement : ferme (et persiste) le segment en cours si actif. */
  stop(): Promise<void> {
    return this.enqueue(async () => {
      const wasRecording = this.state === "recording";
      this.state = transition(this.state, "STOP");
      this.clearCycleTimer();
      if (wasRecording) {
        await this.closeCurrentSegment();
      }
      this.emit();
    });
  }

  /** Nettoyage best-effort (démontage du composant appelant). N'essaie pas de persister. */
  dispose(): void {
    this.clearCycleTimer();
    this.listeners.clear();
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.opQueue.then(fn);
    // On avale l'erreur dans la chaîne interne pour ne jamais bloquer les
    // opérations suivantes ; l'appelant de `enqueue` reçoit `result`, qui lui
    // continue de rejeter normalement.
    this.opQueue = result.catch(() => undefined);
    return result;
  }

  private clearCycleTimer(): void {
    if (this.cycleTimer !== undefined) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = undefined;
    }
  }

  private async beginCycle(): Promise<void> {
    const remaining = this.maxDurationMs - this.accumulatedMs;
    if (remaining <= 0) {
      await this.finishOnCap();
      return;
    }

    try {
      const cycleBudget = Math.min(this.segmentMs, remaining);
      this.cappedThisCycle = cycleBudget >= remaining;
      this.cycleChunks = [];
      this.cycleStartedAt = this.now();

      const recorder = this.createMediaRecorder(this.stream, { mimeType: this.mimeType! });
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) this.cycleChunks.push(event.data);
      };
      this.currentRecorder = recorder;
      recorder.start(INTERNAL_TIMESLICE_MS);

      this.cycleTimer = setTimeout(() => {
        this.enqueue(() => this.onCycleTimerFired()).catch(() => {
          // Déjà reflété dans l'état/snapshot ; rien de plus à faire ici.
        });
      }, cycleBudget);
    } catch (rawError) {
      this.state = transition(this.state, "ERROR");
      this.lastError =
        rawError instanceof RecorderError
          ? rawError
          : new RecorderError("unknown", messageFor("unknown"));
      this.emit();
      throw this.lastError;
    }
  }

  private async onCycleTimerFired(): Promise<void> {
    // Le minuteur peut être obsolète si pause()/stop() ont déjà traité ce
    // cycle entre-temps (annulé via clearTimeout, mais on se protège quand
    // même de toute réentrance résiduelle).
    if (this.state !== "recording") return;

    await this.closeCurrentSegment();
    if (this.cappedThisCycle) {
      await this.finishOnCap();
    } else {
      await this.beginCycle();
    }
  }

  private async finishOnCap(): Promise<void> {
    this.clearCycleTimer();
    this.lastError = maxDurationReachedError();
    this.state = transition(this.state, "STOP");
    this.emit();
  }

  /** Ferme le cycle en cours : arrête le MediaRecorder, assemble le Blob, PERSISTE, met à jour les compteurs. */
  private async closeCurrentSegment(): Promise<void> {
    const recorder = this.currentRecorder;
    if (!recorder) return;

    const durationMs = Math.max(0, this.now() - this.cycleStartedAt);
    await this.stopRecorderAndFlush(recorder);

    const blob = new Blob(this.cycleChunks, { type: this.mimeType });
    this.currentRecorder = undefined;
    this.cycleChunks = [];

    // Persistance IMMÉDIATE, avant tout autre traitement : c'est le cœur du
    // critère « zéro perte ». Un crash après cette ligne ne perd rien de ce
    // segment ; avant cette ligne, il ne perd au pire que ce seul segment.
    const seq = this.nextSeq;
    await this.store.appendSegment({
      noteId: this.noteId,
      seq,
      blob,
      mimeType: this.mimeType!,
      durationMs,
    });
    this.nextSeq += 1;
    this.accumulatedMs += durationMs;
    await this.store.updateNote(this.noteId, { durationMs: this.accumulatedMs });

    // Notifie les abonnés (le hook React, notamment) : sans cet appel, une
    // rotation « normale » de segment (ni pause, ni arrêt, ni plafond) ne
    // serait jamais visible en dehors d'une lecture explicite de `getSnapshot()`.
    this.emit();
  }

  private stopRecorderAndFlush(recorder: MediaRecorder): Promise<void> {
    return new Promise((resolve, reject) => {
      if (recorder.state === "inactive") {
        resolve();
        return;
      }
      recorder.onstop = () => resolve();
      recorder.onerror = () => {
        reject(new RecorderError("unknown", messageFor("unknown")));
      };
      recorder.stop();
    });
  }

  private buildSnapshot(): RecorderEngineSnapshot {
    const liveMs =
      this.state === "recording" && this.currentRecorder
        ? Math.max(0, this.now() - this.cycleStartedAt)
        : 0;
    return {
      state: this.state,
      segmentCount: this.nextSeq,
      elapsedMs: this.accumulatedMs + liveMs,
      error: this.lastError,
    };
  }

  private emit(): void {
    const snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
