/**
 * File d'upload + transcription, sans dépendance à React — comme
 * `src/lib/recorder/engine.ts`. Un hook fin (`useUploadQueue.ts`) l'expose aux
 * composants.
 *
 * Enchaînement par segment (ticket P3-4) :
 *
 *   segment local → jeton (POST /api/blob/upload-token) → upload direct Blob
 *                 → POST /api/transcribe → transcript persisté → statut done
 *
 * Principe directeur : **le `NoteStore` est la seule source de vérité**. Cette
 * classe ne garde AUCUNE copie de l'état des segments en mémoire — à chaque
 * passe (`tick`), elle relit `listPendingSegments()` (pour l'upload) et
 * `listSegments()` (pour repérer les segments déjà uploadés mais pas encore
 * transcrits, que `listPendingSegments()` ne couvre pas par contrat). Le seul
 * état interne conservé ici est *non durable et non métier* : la
 * planification du backoff et l'ensemble des envois en vol (`inFlight`), tous
 * deux reconstructibles sans perte à partir de zéro après un refresh — un
 * segment qui redémarre son backoff à zéro n'est jamais un segment perdu.
 *
 * Reprise à l'étape qui a échoué (règle n°6 du ticket) : la présence de
 * `Segment.blobUrl` est le seul signal utilisé pour décider de sauter
 * l'upload. Aucun champ supplémentaire n'est nécessaire : un segment `error`
 * ou `uploading` sans `blobUrl` reprend l'upload depuis le début (écrase le
 * même chemin de blob, sans risque) ; un segment `uploaded`, `transcribing`,
 * ou `error` AVEC `blobUrl` ne reprend qu'à la transcription.
 */
import { NoteNotFoundError, SegmentNotFoundError } from "@/lib/store/errors";
import type { LangSetting, Note, NoteStore, Segment } from "@/types/notes";

import { computeBackoffDelayMs } from "./backoff";
import { ambiguousExhaustedMessage, classifyUploadError, type RetryTier } from "./errors";
import { deriveNoteRollup } from "./noteRollup";

export interface QueueSegmentContext {
  segmentId: string;
  noteId: string;
  seq: number;
  blob: Blob;
  mimeType: string;
  durationMs: number;
  lang: LangSetting;
  blobUrl?: string;
  /** Tentatives d'upload déjà effectuées pour ce segment (`Segment.attempts`). */
  attempts: number;
}

export type UploadSegmentFn = (ctx: QueueSegmentContext) => Promise<string>;

export interface TranscribeSegmentResult {
  text: string;
  provider: string;
}

export type TranscribeSegmentFn = (
  ctx: QueueSegmentContext & { blobUrl: string },
) => Promise<TranscribeSegmentResult>;

export type QueueGlobalStatus = "idle" | "syncing" | "offline" | "error";

export interface QueueSnapshot {
  globalStatus: QueueGlobalStatus;
  /** Segments encore à uploader ou à transcrire, toutes notes confondues. */
  pendingCount: number;
  /** Incrémenté à chaque écriture dans le `NoteStore` : signal pour relire le store. */
  revision: number;
}

export type UploadQueueListener = (snapshot: QueueSnapshot) => void;

export interface UploadQueueOptions {
  store: NoteStore;
  uploadSegment: UploadSegmentFn;
  transcribeSegment: TranscribeSegmentFn;
  /** Envois simultanés au maximum. Défaut : 3 (ticket P3-4, règle n°4). */
  concurrency?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Tentatives max d'une erreur "ambiguous" avant arrêt définitif (voir errors.ts). */
  maxAmbiguousAttempts?: number;
  /** Injectable pour les tests. Défaut : `navigator.onLine`. */
  isOnline?: () => boolean;
  /** Horloge injectable pour les tests. Défaut : `Date.now`. */
  now?: () => number;
}

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_AMBIGUOUS_ATTEMPTS = 5;

interface RetryBookkeeping {
  /** Échecs consécutifs depuis le dernier succès ou la dernière remise à zéro manuelle. */
  attempt: number;
  /** Échecs "ambiguous" consécutifs — plafonnés indépendamment (voir errors.ts). */
  ambiguousStreak: number;
  /**
   * Epoch ms ; 0 = prêt immédiatement. `STOPPED` (`+Infinity`) = échec
   * définitif : ne JAMAIS redevenir prêt tout seul. Un segment `error` reste
   * `error` par contrat (`PENDING_SEGMENT_STATUSES` inclut `error`, quelle
   * que soit sa cause) — sans ce sentinel distinct de « pas encore essayé »,
   * l'absence d'entrée dans `retryState` après suppression rendrait un échec
   * définitif indiscernable d'un segment neuf, et la file le retenterait en
   * boucle serrée dès la passe suivante (bug constaté en test : voir
   * queue.test.ts, cas "retryable: false").
   */
  nextRetryAt: number;
}

/** Sentinel `nextRetryAt` d'un échec définitif — voir `RetryBookkeeping.nextRetryAt`. */
const STOPPED = Number.POSITIVE_INFINITY;

function isMissingEntityError(err: unknown): boolean {
  return err instanceof NoteNotFoundError || err instanceof SegmentNotFoundError;
}

function toContext(segment: Segment, note: Note): QueueSegmentContext {
  return {
    segmentId: segment.id,
    noteId: segment.noteId,
    seq: segment.seq,
    blob: segment.blob,
    mimeType: segment.mimeType,
    durationMs: segment.durationMs,
    lang: note.lang,
    blobUrl: segment.blobUrl,
    attempts: segment.attempts,
  };
}

/**
 * Reconstruit la liste des segments à traiter, uniquement depuis le
 * `NoteStore` — jamais depuis un état parallèle. Union de deux lectures :
 * `listPendingSegments()` (upload : `local`/`uploading`/`error`, quelle que
 * soit l'étape où l'erreur est survenue — voir le commentaire de tête) et un
 * balayage des notes pour les segments `uploaded`/`transcribing` que
 * `listPendingSegments()` ne couvre pas par contrat.
 */
export async function collectQueueItems(store: NoteStore): Promise<QueueSegmentContext[]> {
  const notes = await store.listNotes();
  const noteById = new Map(notes.map((note) => [note.id, note] as const));

  const items: QueueSegmentContext[] = [];
  const seen = new Set<string>();

  const pendingUpload = await store.listPendingSegments();
  for (const segment of pendingUpload) {
    const note = noteById.get(segment.noteId);
    if (!note) continue; // Note supprimée entre-temps : segment orphelin, ignoré.
    items.push(toContext(segment, note));
    seen.add(segment.id);
  }

  for (const note of notes) {
    const segments = await store.listSegments(note.id);
    for (const segment of segments) {
      if (seen.has(segment.id)) continue;
      if (segment.status === "uploaded" || segment.status === "transcribing") {
        items.push(toContext(segment, note));
        seen.add(segment.id);
      }
    }
  }

  return items;
}

export class UploadQueue {
  private readonly store: NoteStore;
  private readonly uploadSegment: UploadSegmentFn;
  private readonly transcribeSegment: TranscribeSegmentFn;
  private readonly concurrency: number;
  private readonly baseDelayMs: number | undefined;
  private readonly maxDelayMs: number | undefined;
  private readonly maxAmbiguousAttempts: number;
  private readonly isOnline: () => boolean;
  private readonly now: () => number;

  private readonly listeners = new Set<UploadQueueListener>();
  private readonly inFlight = new Set<string>();
  private readonly retryState = new Map<string, RetryBookkeeping>();
  private readonly forcedNow = new Set<string>();

  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private tickPromise: Promise<void> | null = null;
  private rerunRequested = false;
  private running = false;
  private revision = 0;
  private pendingCountCache = 0;
  private stuckCountCache = 0;

  constructor(options: UploadQueueOptions) {
    this.store = options.store;
    this.uploadSegment = options.uploadSegment;
    this.transcribeSegment = options.transcribeSegment;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.baseDelayMs = options.baseDelayMs;
    this.maxDelayMs = options.maxDelayMs;
    this.maxAmbiguousAttempts = options.maxAmbiguousAttempts ?? DEFAULT_MAX_AMBIGUOUS_ATTEMPTS;
    this.isOnline = options.isOnline ?? (() => (typeof navigator === "undefined" ? true : navigator.onLine));
    this.now = options.now ?? (() => Date.now());
  }

  getSnapshot(): QueueSnapshot {
    return {
      globalStatus: this.computeGlobalStatus(),
      pendingCount: this.pendingCountCache,
      revision: this.revision,
    };
  }

  subscribe(listener: UploadQueueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * À appeler au montage : reprend depuis ce que dit le `NoteStore`. Sans
   * effet si déjà démarrée. Renvoie une promesse pour les tests (attend que
   * tout ce qui est immédiatement traitable le soit) ; le hook React n'a pas
   * à l'attendre.
   */
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.running = true;
    return this.tick();
  }

  /**
   * Arrête de planifier de nouveaux passages. N'annule PAS les envois déjà en
   * vol (ils se terminent et écrivent leur résultat normalement) : un
   * démontage de composant ne doit jamais interrompre un upload en cours, le
   * prochain `start()` (ou une autre page) reprendra le reste depuis le store.
   */
  stop(): void {
    this.running = false;
    if (this.wakeTimer !== undefined) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
  }

  /** Un nouveau segment vient d'être persisté, ou le réseau vient de revenir : relit tout de suite. */
  wake(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return this.tick();
  }

  /**
   * Bouton « Réessayer » (ticket P3-5) : tente CE segment immédiatement, sans
   * attendre le reste de son backoff, et lui redonne un plein budget de
   * tentatives "ambiguous" — une action explicite de l'utilisateur mérite un
   * nouvel essai franc, pas la fin d'un compteur déjà entamé en silence.
   */
  retrySegment(segmentId: string): Promise<void> {
    this.retryState.delete(segmentId);
    this.forcedNow.add(segmentId);
    return this.running ? this.tick() : Promise.resolve();
  }

  /**
   * Priorité : hors-ligne d'abord (rassurer prime sur tout, ticket P3-5) ;
   * puis "en cours" tant qu'un envoi est en vol OU qu'il reste au moins un
   * segment en attente qui n'est pas définitivement arrêté ; "en erreur"
   * seulement quand TOUT ce qui reste en attente est un échec définitif
   * (rien à espérer sans action de l'utilisateur) ; "idle" quand il n'y a
   * plus rien en attente du tout.
   */
  private computeGlobalStatus(): QueueGlobalStatus {
    if (!this.isOnline()) return "offline";
    if (this.inFlight.size > 0) return "syncing";
    if (this.pendingCountCache === 0) return "idle";
    return this.pendingCountCache > this.stuckCountCache ? "syncing" : "error";
  }

  private emit(): void {
    this.revision += 1;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  /** Sérialise les passes : une relecture du store en cours n'est jamais chevauchée par une seconde. */
  private tick(): Promise<void> {
    if (this.tickPromise) {
      this.rerunRequested = true;
      return this.tickPromise;
    }
    this.tickPromise = this.runTickLoop();
    return this.tickPromise;
  }

  private async runTickLoop(): Promise<void> {
    try {
      do {
        this.rerunRequested = false;
        await this.runTick();
      } while (this.rerunRequested);
    } finally {
      this.tickPromise = null;
    }
  }

  /**
   * Traite, par lots plafonnés à `concurrency`, tout ce qui est immédiatement
   * prêt — en relisant le `NoteStore` avant chaque lot (jamais un instantané
   * figé) — puis s'arrête dès qu'il ne reste plus rien de prêt maintenant,
   * en programmant un réveil pour le prochain segment dont le backoff expire
   * s'il y en a un. Un lot attend toujours la fin du précédent avant de
   * relire le store : plus simple à raisonner et à tester qu'un pool qui
   * réutilise en continu les places libérées, au prix d'une concurrence
   * parfois légèrement sous-utilisée (une place libérée en cours de lot
   * attend la fin du lot plutôt que d'être immédiatement réoccupée) — un
   * compromis délibéré, sans incidence sur la garantie « zéro perte » ni sur
   * le plafond de concurrence lui-même, qui reste strictement respecté.
   */
  private async runTick(): Promise<void> {
    for (;;) {
      if (!this.running) return;

      if (this.wakeTimer !== undefined) {
        clearTimeout(this.wakeTimer);
        this.wakeTimer = undefined;
      }

      // Le compte de segments en attente est relu même hors-ligne : un
      // utilisateur qui rouvre l'app sans réseau doit voir que ses segments
      // sont toujours là, pas un compteur à zéro qui laisserait croire à une
      // perte (voir ticket P3-5, « rassurer »).
      const items = await collectQueueItems(this.store);
      this.pendingCountCache = items.length;
      // Segments définitivement arrêtés (échec non-retryable, ou "ambiguous"
      // ayant épuisé son plafond) parmi ceux en attente : ni en cours, ni
      // programmés pour un nouvel essai — voir `computeGlobalStatus` et le
      // sentinel `STOPPED`.
      this.stuckCountCache = items.filter(
        (item) =>
          !this.forcedNow.has(item.segmentId) &&
          this.retryState.get(item.segmentId)?.nextRetryAt === STOPPED,
      ).length;

      const liveIds = new Set(items.map((item) => item.segmentId));
      for (const id of this.retryState.keys()) {
        if (!liveIds.has(id)) this.retryState.delete(id);
      }
      for (const id of this.forcedNow) {
        if (!liveIds.has(id)) this.forcedNow.delete(id);
      }

      if (!this.isOnline()) {
        // Rien à programmer hors-ligne : l'écouteur 'online' du hook appelle
        // wake() dès le retour du réseau. Ne rien tenter maintenant, ce
        // serait un échec réseau garanti consommant une tentative pour rien.
        this.emit();
        return;
      }

      const now = this.now();
      const ready: QueueSegmentContext[] = [];
      let earliestWaitAt: number | undefined;

      for (const item of items) {
        const dueAt = this.forcedNow.has(item.segmentId)
          ? 0
          : (this.retryState.get(item.segmentId)?.nextRetryAt ?? 0);
        if (dueAt <= now) {
          ready.push(item);
        } else if (dueAt !== STOPPED && (earliestWaitAt === undefined || dueAt < earliestWaitAt)) {
          // STOPPED (échec définitif) n'est jamais reprogrammé tout seul : un
          // setTimeout(±Infinity) déborderait le délai 32 bits et pourrait se
          // déclencher immédiatement selon le runtime, provoquant la boucle
          // serrée que ce sentinel existe justement pour éviter.
          earliestWaitAt = dueAt;
        }
      }

      if (ready.length === 0) {
        if (earliestWaitAt !== undefined) {
          const delay = Math.max(0, earliestWaitAt - now);
          this.wakeTimer = setTimeout(() => {
            this.wakeTimer = undefined;
            void this.tick();
          }, delay);
        }
        this.emit();
        return;
      }

      const batch = ready.slice(0, this.concurrency);
      for (const item of batch) {
        this.inFlight.add(item.segmentId);
        this.forcedNow.delete(item.segmentId);
      }
      this.emit();

      await Promise.all(
        batch.map((item) =>
          this.runItem(item).finally(() => {
            this.inFlight.delete(item.segmentId);
          }),
        ),
      );
      // Relit le store et retente un lot : d'autres segments (ou le même,
      // passé de "uploaded" à prêt pour la transcription) peuvent désormais
      // être prêts.
    }
  }

  private async runItem(item: QueueSegmentContext): Promise<void> {
    try {
      let blobUrl = item.blobUrl;
      if (!blobUrl) {
        await this.store.updateSegment(item.segmentId, {
          status: "uploading",
          attempts: item.attempts + 1,
        });
        this.emit();
        blobUrl = await this.uploadSegment(item);
        await this.store.updateSegment(item.segmentId, {
          status: "uploaded",
          blobUrl,
          error: undefined,
        });
        this.emit();
      }

      await this.store.updateSegment(item.segmentId, { status: "transcribing" });
      this.emit();
      const result = await this.transcribeSegment({ ...item, blobUrl });
      await this.store.putTranscript({
        noteId: item.noteId,
        seq: item.seq,
        text: result.text,
        provider: result.provider,
        createdAt: this.now(),
      });
      await this.store.updateSegment(item.segmentId, { status: "done", error: undefined });
      this.retryState.delete(item.segmentId);
      await this.syncNote(item.noteId);
    } catch (rawError) {
      if (isMissingEntityError(rawError)) {
        // Note ou segment supprimé entre-temps (RGPD) : rien à retenter, rien
        // à signaler — la suppression a déjà fait le ménage.
        this.retryState.delete(item.segmentId);
        return;
      }
      await this.handleFailure(item, rawError);
    } finally {
      this.emit();
    }
  }

  private async handleFailure(item: QueueSegmentContext, rawError: unknown): Promise<void> {
    const classification = classifyUploadError(rawError);
    const state: RetryBookkeeping = this.retryState.get(item.segmentId) ?? {
      attempt: 0,
      ambiguousStreak: 0,
      nextRetryAt: 0,
    };
    state.attempt += 1;

    let tier: RetryTier = classification.tier;
    let message = classification.message;

    if (tier === "ambiguous") {
      state.ambiguousStreak += 1;
      if (state.ambiguousStreak > this.maxAmbiguousAttempts) {
        tier = "non-retryable";
        message = ambiguousExhaustedMessage();
      }
    } else {
      state.ambiguousStreak = 0;
    }

    try {
      await this.store.updateSegment(item.segmentId, { status: "error", error: message });
    } catch (writeErr) {
      if (isMissingEntityError(writeErr)) {
        this.retryState.delete(item.segmentId);
        return;
      }
      // Panne de stockage en écrivant l'échec lui-même : sans plus
      // d'insistance ici, le prochain tick relira l'état réel du store.
      return;
    }

    if (tier === "non-retryable") {
      state.nextRetryAt = STOPPED;
      this.retryState.set(item.segmentId, state);
    } else {
      state.nextRetryAt =
        this.now() +
        computeBackoffDelayMs(state.attempt, {
          baseDelayMs: this.baseDelayMs,
          maxDelayMs: this.maxDelayMs,
        });
      this.retryState.set(item.segmentId, state);
    }

    await this.syncNote(item.noteId).catch(() => {});
  }

  /**
   * Met à jour `Note.status`/`Note.text` d'après l'état réel des segments
   * (voir noteRollup.ts). Ne touche jamais une note encore `"recording"` :
   * cette transition appartient à l'écran d'enregistrement, seul à savoir si
   * une session est encore active.
   */
  private async syncNote(noteId: string): Promise<void> {
    try {
      const note = await this.store.getNote(noteId);
      if (!note || note.status === "recording") return;

      const [segments, transcripts] = await Promise.all([
        this.store.listSegments(noteId),
        this.store.listTranscripts(noteId),
      ]);
      const rollup = deriveNoteRollup(segments, transcripts);
      if (!rollup) return;

      const patch: Partial<Omit<Note, "id">> = {};
      if (rollup.status !== note.status) patch.status = rollup.status;
      if (rollup.text !== undefined && !note.textEdited && rollup.text !== note.text) {
        patch.text = rollup.text;
      }
      if (Object.keys(patch).length > 0) {
        await this.store.updateNote(noteId, patch);
      }
    } catch {
      // Best-effort : une note disparue entre-temps ne doit jamais faire
      // échouer le traitement du segment qui vient de réussir ou d'échouer.
    }
  }
}
