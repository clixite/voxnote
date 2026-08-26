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
 * Pas de `timeslice` du tout, même à l'intérieur d'un cycle : un `stop()`
 * émet toujours un dernier `dataavailable` avec tout ce qui a été capté
 * depuis le début du cycle, donc un seul morceau par segment suffit. Un
 * timeslice interne avait été ajouté en pensant limiter la perte si l'onglet
 * meurt en cours de segment — c'est faux (les morceaux restent en mémoire
 * jusqu'à la fin du cycle, comme sans timeslice) et le coût n'est pas nul :
 * passer un timeslice à `start()` peut changer la structure du conteneur
 * produit par Safari, exactement le risque que cette section cherche à
 * écarter (voir docs/ARCHITECTURE.md).
 *
 * Zéro perte : chaque segment fermé est écrit dans le `NoteStore` AVANT toute
 * autre chose (avant même de démarrer le cycle suivant), avec quelques essais
 * en cas d'échec d'écriture (`persistSegment`). Le blob n'est jamais jeté tant
 * que l'écriture n'a pas réussi : `currentRecorder` et `cycleChunks` ne sont
 * libérés qu'après ce succès. Si l'écriture reste impossible (stockage
 * saturé), l'enregistrement s'arrête proprement en état `error`, jamais en
 * silence — voir `closeCurrentSegment` et `handleFatalError`.
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
  storageFullError,
} from "./errors";
import { transition, type RecorderState } from "./machine";
import { pickSupportedMimeType, type IsTypeSupportedFn } from "./mime-types";

/** Tentatives d'écriture d'un segment avant d'abandonner (1 essai + 2 reprises). */
const PERSIST_MAX_ATTEMPTS = 3;

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

  /**
   * Met en pause : ferme (et persiste) le segment en cours, ne perd rien.
   * L'état ne passe à `paused` qu'après le succès de cette persistance — en
   * cas d'échec définitif, `closeCurrentSegment` a déjà basculé en `error`
   * et notifié les abonnés (BLOQUANT B3 de la revue d'architecture).
   */
  pause(): Promise<void> {
    return this.enqueue(async () => {
      const nextState = transition(this.state, "PAUSE");
      this.clearCycleTimer();
      try {
        await this.closeCurrentSegment();
        this.state = nextState;
      } catch (rawError) {
        this.handleFatalError(rawError);
        throw this.lastError;
      } finally {
        this.emit();
      }
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

  /**
   * Arrête définitivement : ferme (et persiste) le segment en cours si actif.
   * Même garde qu'à la pause : l'état ne passe à `stopped` qu'après le succès
   * de cette persistance (BLOQUANT B3).
   */
  stop(): Promise<void> {
    return this.enqueue(async () => {
      const wasRecording = this.state === "recording";
      const nextState = transition(this.state, "STOP");
      this.clearCycleTimer();
      try {
        if (wasRecording) {
          await this.closeCurrentSegment();
        }
        this.state = nextState;
      } catch (rawError) {
        this.handleFatalError(rawError);
        throw this.lastError;
      } finally {
        this.emit();
      }
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

  /**
   * Bascule en `error` de façon irréprochable : appelable depuis n'importe
   * quel état actif (`recording` l'autorise toujours). Centralise la
   * traduction d'une erreur brute en `RecorderError` française — jamais un
   * message technique brut affiché à l'utilisateur.
   */
  private handleFatalError(rawError: unknown): void {
    this.clearCycleTimer();
    this.lastError =
      rawError instanceof RecorderError
        ? rawError
        : new RecorderError("unknown", messageFor("unknown"));
    this.state = transition(this.state, "ERROR");
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
      // Pas de timeslice (voir le commentaire d'en-tête du fichier) : un seul
      // morceau, émis par `stop()`, couvre tout le cycle.
      recorder.start();

      this.cycleTimer = setTimeout(() => {
        this.enqueue(() => this.onCycleTimerFired()).catch(() => {
          // Déjà reflété dans l'état/snapshot par onCycleTimerFired lui-même
          // (son propre try/finally emet avant de laisser filer l'erreur) :
          // rien de plus à faire ici.
        });
      }, cycleBudget);
    } catch (rawError) {
      this.handleFatalError(rawError);
      this.emit();
      throw this.lastError;
    }
  }

  private async onCycleTimerFired(): Promise<void> {
    // Le minuteur peut être obsolète si pause()/stop() ont déjà traité ce
    // cycle entre-temps (annulé via clearTimeout, mais on se protège quand
    // même de toute réentrance résiduelle).
    if (this.state !== "recording") return;

    try {
      await this.closeCurrentSegment();
    } catch (rawError) {
      this.handleFatalError(rawError);
      return;
    } finally {
      this.emit();
    }

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

  /**
   * Ferme le cycle en cours : arrête le `MediaRecorder`, assemble le Blob,
   * PERSISTE (avec plusieurs essais), met à jour les compteurs.
   *
   * Ne touche NI `this.state` NI `emit()` en cas d'échec : c'est la
   * responsabilité de l'appelant (`pause`, `stop`, `onCycleTimerFired`), qui
   * décide dans quel état retomber. Ce qui est garanti ici, c'est que
   * `currentRecorder` et `cycleChunks` ne sont libérés qu'APRÈS un
   * `appendSegment` réussi (BLOQUANT B1 de la revue) : tant que ce n'est pas
   * le cas, le blob capté reste en mémoire, récupérable pour un nouvel essai,
   * au lieu d'être jeté silencieusement pendant qu'un compteur continue de
   * défiler côté UI.
   */
  private async closeCurrentSegment(): Promise<void> {
    const recorder = this.currentRecorder;
    if (!recorder) return;

    const durationMs = Math.max(0, this.now() - this.cycleStartedAt);
    // Peut lever (MediaRecorder en erreur matérielle) : currentRecorder et
    // cycleChunks restent intacts, rien n'est perdu ni marqué comme fermé.
    await this.stopRecorderAndFlush(recorder);

    const blob = new Blob(this.cycleChunks, { type: this.mimeType });
    const seq = this.nextSeq;

    // Peut lever `storageFullError()` après plusieurs essais : le blob assemblé
    // ci-dessus n'est référencé que par cette variable locale et par
    // `this.cycleChunks`, qui n'est vidé qu'après le `return` ci-dessous.
    await this.persistSegment(seq, blob, durationMs);

    this.currentRecorder = undefined;
    this.cycleChunks = [];
    this.nextSeq = seq + 1;
    this.accumulatedMs += durationMs;

    // Le segment est déjà écrit à ce stade : un échec de mise à jour de la
    // note (même cause probable : stockage saturé) est un affichage de durée
    // en retard, pas une perte de données. Ne fait pas échouer tout le cycle
    // pour ça.
    await this.store.updateNote(this.noteId, { durationMs: this.accumulatedMs }).catch(() => {});
  }

  /**
   * Écrit le segment dans le `NoteStore`, avec quelques essais immédiats
   * avant d'abandonner (`PERSIST_MAX_ATTEMPTS`). Le détail technique de
   * l'échec (quota, base bloquée...) n'est jamais exposé : seul un
   * `storageFullError()` générique et actionnable remonte à l'appelant.
   */
  private async persistSegment(seq: number, blob: Blob, durationMs: number): Promise<void> {
    for (let attempt = 1; attempt <= PERSIST_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.store.appendSegment({
          noteId: this.noteId,
          seq,
          blob,
          mimeType: this.mimeType!,
          durationMs,
        });
        return;
      } catch {
        // Retenté silencieusement jusqu'à épuisement des essais ci-dessous.
      }
    }
    throw storageFullError();
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
