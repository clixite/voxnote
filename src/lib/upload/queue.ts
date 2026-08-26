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
 *
 * Réservation par onglet (B2, revue sécurité — deux passes) : `inFlight`
 * est en mémoire, donc par onglet — rien n'empêchait deux onglets ouverts
 * sur la même note de traiter le même segment en parallèle (upload payé
 * deux fois, `allowOverwrite` faisant réussir silencieusement le doublon
 * plutôt que le rejeter).
 *
 * Une première version filtrait les segments déjà réservés dans
 * `collectQueueItems` (lecture) avant d'écrire la réservation dans
 * `runItem` — insuffisant : l'événement `online` réveille TOUS les onglets
 * EN MÊME TEMPS après une coupure, donc tous lisent « libre » avant qu'aucun
 * n'ait écrit. Démontré en revue : 6 transcriptions facturées pour 3
 * segments, de façon déterministe. Le filtrage optimiste de
 * `collectQueueItems` reste en place (il évite des tentatives de réservation
 * inutiles), mais ce n'est plus lui qui décide : `store.claimSegment`
 * réserve dans une seule transaction IndexedDB (voir `src/types/notes.ts`),
 * ce qu'IndexedDB sérialise par construction sur un même object store —
 * c'est la primitive d'exclusion mutuelle qui manquait. Seul un `claimSegment`
 * qui renvoie `true` fait entrer un segment dans le lot traité (`runTick`).
 *
 * La réservation est rafraîchie pendant tout traitement effectif
 * (`withClaimHeartbeat`, en réutilisant `claimSegment` lui-même — voir son
 * commentaire), et libérée via `store.releaseSegment` sur succès. PAS sur un
 * échec retryable : `retryState` (le backoff, le plafond "ambiguous") est en
 * mémoire, par onglet, et libérer la réservation la rendrait immédiatement
 * reprenable par un autre onglet qui n'a connaissance ni de l'un ni de
 * l'autre — contournant le plafond de tentatives à deux onglets (deuxième
 * défaut démontré par la même sonde). Voir l'argumentaire complet en tête de
 * `handleFailure`.
 */
import {
  HEARTBEAT_INTERVAL_MS,
  STALE_THRESHOLD_MS,
} from "@/components/activeRecordingMarker";
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
  /**
   * Identifiant de CET onglet, pour la réservation de segment (B2). Doit
   * réutiliser le même identifiant que le marqueur d'enregistrement
   * (`getTabId()` de `@/components/activeRecordingMarker`, câblé par
   * `useUploadQueue.ts`) : deux identifiants d'onglet concurrents dans la
   * même appli seraient absurdes. Défaut ici (tests, usage hors navigateur) :
   * un identifiant frais par instance.
   */
  tabId?: string;
}

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_AMBIGUOUS_ATTEMPTS = 5;
/** Nouvel essai après une lecture du `NoteStore` elle-même en échec (voir `runTick`). */
const STORE_RETRY_DELAY_MS = 3000;
/** Nouvel essai après une passe où aucune réservation atomique n'a abouti (voir `runTick`). */
const CLAIM_CONTENTION_RETRY_MS = 1000;

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

/** Repli si aucun `tabId` n'est fourni (tests, usage hors navigateur) : voir `UploadQueueOptions.tabId`. */
function generateFallbackTabId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `queue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isMissingEntityError(err: unknown): boolean {
  return err instanceof NoteNotFoundError || err instanceof SegmentNotFoundError;
}

/**
 * `true` si CE segment SEMBLE traitable par `tabId` maintenant, d'après une
 * lecture non atomique : jamais réservé, réservé par `tabId` lui-même
 * (reprise du même onglet après un refresh, `claimedBy` vit dans
 * `sessionStorage` — voir `activeRecordingMarker.ts`), ou réservé mais
 * périmé (onglet mort, ne doit jamais bloquer un segment pour de bon —
 * l'erreur symétrique, pire : un segment jamais transcrit vaut moins qu'un
 * segment transcrit deux fois).
 *
 * PUREMENT OPTIMISTE : sert uniquement de premier tri dans
 * `collectQueueItems`, pour éviter d'appeler `store.claimSegment` sur des
 * segments visiblement déjà pris. Ne décide jamais qui obtient réellement un
 * segment — seul `claimSegment` (atomique) en est capable (voir le
 * commentaire de tête du fichier).
 */
export function isSegmentClaimAvailable(
  segment: Pick<Segment, "claimedBy" | "claimedAt">,
  tabId: string,
  now: number,
): boolean {
  if (!segment.claimedBy) return true;
  if (segment.claimedBy === tabId) return true;
  return now - (segment.claimedAt ?? 0) > STALE_THRESHOLD_MS;
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
 *
 * `tabId` filtre au passage les segments réservés par un AUTRE onglet et
 * dont la réservation est encore fraîche (B2, voir `isSegmentClaimAvailable`)
 * : ils n'apparaissent tout simplement pas dans le résultat. Ce filtre est
 * OPTIMISTE, pas décisionnel (voir le commentaire de tête de `runTick`) :
 * il évite d'essayer de réserver des segments visiblement déjà pris, mais
 * seul `store.claimSegment` — appelé ensuite, atomiquement — décide qui
 * obtient réellement un segment.
 */
export async function collectQueueItems(
  store: NoteStore,
  tabId: string,
  now: number = Date.now(),
): Promise<QueueSegmentContext[]> {
  const notes = await store.listNotes();
  const noteById = new Map(notes.map((note) => [note.id, note] as const));

  const items: QueueSegmentContext[] = [];
  const seen = new Set<string>();

  const pendingUpload = await store.listPendingSegments();
  for (const segment of pendingUpload) {
    const note = noteById.get(segment.noteId);
    if (!note) continue; // Note supprimée entre-temps : segment orphelin, ignoré.
    seen.add(segment.id);
    if (!isSegmentClaimAvailable(segment, tabId, now)) continue;
    items.push(toContext(segment, note));
  }

  for (const note of notes) {
    const segments = await store.listSegments(note.id);
    for (const segment of segments) {
      if (seen.has(segment.id)) continue;
      if (segment.status === "uploaded" || segment.status === "transcribing") {
        seen.add(segment.id);
        if (!isSegmentClaimAvailable(segment, tabId, now)) continue;
        items.push(toContext(segment, note));
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
  private readonly tabId: string;

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
    // Défaut de secours seulement : le vrai identifiant partagé avec le
    // marqueur d'enregistrement est câblé par useUploadQueue.ts (getTabId()
    // de @/components/activeRecordingMarker) — voir UploadQueueOptions.tabId.
    this.tabId = options.tabId ?? generateFallbackTabId();
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
   *
   * Réservation (B2, deuxième passe de revue) : `collectQueueItems` ne fait
   * qu'un premier tri OPTIMISTE — il évite d'essayer de réserver des
   * segments visiblement déjà pris, mais son verdict n'est jamais celui qui
   * décide. Entre cette lecture et l'écriture de réservation, une fenêtre
   * existe (`listNotes` + `listPendingSegments` + un `listSegments` par
   * note) — pas quelques microsecondes : la durée d'une passe complète.
   * L'événement `online` réveille TOUS les onglets en même temps après une
   * coupure ; sans verrou, chacun lirait « libre » avant qu'aucun n'ait
   * écrit (démontré en revue : 6 transcriptions pour 3 segments). Seul
   * `store.claimSegment` — une unique transaction IndexedDB, atomique par
   * construction — décide réellement : un candidat n'entre dans le lot
   * traité que si son appel a renvoyé `true`.
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
      let items: QueueSegmentContext[];
      try {
        items = await collectQueueItems(this.store, this.tabId, this.now());
      } catch {
        // Le NoteStore lui-même est momentanément inaccessible (IndexedDB pas
        // encore prête, panne ponctuelle...) : jamais de rejection non gérée
        // qui casserait la file pour de bon, un nouvel essai plus tard suffit.
        this.wakeTimer = setTimeout(() => {
          this.wakeTimer = undefined;
          void this.tick();
        }, STORE_RETRY_DELAY_MS);
        this.emit();
        return;
      }
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

      // Décision réelle : tente une réservation ATOMIQUE pour chaque
      // candidat optimiste, dans l'ordre, jusqu'à `concurrency` réservations
      // obtenues ou plus de candidats. Un `false` (un autre onglet a gagné
      // la course) n'est jamais une erreur : ce candidat est simplement
      // laissé de côté ce tour-ci, la prochaine relecture du store reflétera
      // la réalité (sa réservation, désormais visible, l'exclura du tri
      // optimiste suivant).
      const claimed: QueueSegmentContext[] = [];
      const staleBefore = now - STALE_THRESHOLD_MS;
      for (const item of ready) {
        if (claimed.length >= this.concurrency) break;
        let ok: boolean;
        try {
          ok = await this.store.claimSegment(item.segmentId, this.tabId, staleBefore);
        } catch {
          // Panne du store en réservant : ni erreur de segment, ni succès —
          // on n'insiste pas ce tour-ci, la prochaine relecture retentera.
          continue;
        }
        if (ok) claimed.push(item);
      }

      if (claimed.length === 0) {
        // Rien obtenu : soit tout était déjà pris pour de bon (rare — le
        // tri optimiste l'aurait normalement déjà filtré), soit une course
        // perdue de justesse. Dans les deux cas, retenter en boucle serrée
        // n'aiderait pas : un court délai laisse la vraie réservation du
        // gagnant se refléter avant la prochaine tentative.
        this.wakeTimer = setTimeout(() => {
          this.wakeTimer = undefined;
          void this.tick();
        }, CLAIM_CONTENTION_RETRY_MS);
        this.emit();
        return;
      }

      for (const item of claimed) {
        this.inFlight.add(item.segmentId);
        this.forcedNow.delete(item.segmentId);
      }
      this.emit();

      await Promise.all(
        claimed.map((item) =>
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

  /**
   * Pendant tout traitement effectif (upload ou transcription) d'un segment
   * déjà réservé (par `runTick`, avant d'appeler `runItem`), rafraîchit la
   * réservation à intervalle régulier — même cadence que le heartbeat du
   * marqueur d'enregistrement (`HEARTBEAT_INTERVAL_MS`, choisie sous le pire
   * cas de throttling des onglets d'arrière-plan). Sans ça, un traitement
   * plus long que `STALE_THRESHOLD_MS` (transcription lente, upload sur
   * réseau mobile faible) serait vu comme abandonné par un autre onglet, qui
   * se remettrait alors à le traiter en parallèle.
   *
   * Réutilise `claimSegment` plutôt qu'une écriture `updateSegment` brute :
   * c'est ce qui rend le rafraîchissement conditionnel à la propriété de la
   * réservation SANS code séparé pour le vérifier (détail relevé en revue —
   * un heartbeat qui écrirait `claimedAt` sans revérifier `claimedBy`
   * rafraîchirait la réservation d'un AUTRE onglet si celui-ci avait repris
   * un segment entre-temps déclaré périmé). `claimSegment` refuse déjà tout
   * ce qui n'est pas "libre, à nous, ou périmé" — le heartbeat en hérite
   * gratuitement.
   */
  private async withClaimHeartbeat<T>(segmentId: string, work: () => Promise<T>): Promise<T> {
    const timer = setInterval(() => {
      const staleBefore = this.now() - STALE_THRESHOLD_MS;
      void this.store.claimSegment(segmentId, this.tabId, staleBefore).catch(() => {
        // Best-effort : un raté de heartbeat n'interrompt pas le travail en
        // cours, seul son résultat final compte pour le statut du segment.
      });
    }, HEARTBEAT_INTERVAL_MS);
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * Traite UN segment déjà réservé avec succès par `runTick` (voir
   * `store.claimSegment`, appelé avant que ce segment n'atteigne cette
   * méthode) : `runItem` ne réserve plus rien lui-même, il tient la
   * réservation déjà acquise (rafraîchie par `withClaimHeartbeat`) et la
   * libère explicitement à la fin — voir `handleFailure` pour l'argumentaire
   * sur QUAND la libérer en cas d'échec.
   */
  private async runItem(item: QueueSegmentContext): Promise<void> {
    try {
      let blobUrl = item.blobUrl;
      if (!blobUrl) {
        await this.store.updateSegment(item.segmentId, {
          status: "uploading",
          attempts: item.attempts + 1,
        });
        this.emit();
        blobUrl = await this.withClaimHeartbeat(item.segmentId, () => this.uploadSegment(item));
        await this.store.updateSegment(item.segmentId, {
          status: "uploaded",
          blobUrl,
          error: undefined,
        });
        this.emit();
      }
      // Capturé dans une `const` avant la fermeture ci-dessous : après le
      // bloc précédent, `blobUrl` est bien un `string` (narrowing normal),
      // mais une fermeture passée à `withClaimHeartbeat` n'hérite pas de
      // cette certitude — TypeScript la revérifierait sinon à chaque appel.
      const resolvedBlobUrl: string = blobUrl;

      await this.store.updateSegment(item.segmentId, { status: "transcribing" });
      this.emit();
      const result = await this.withClaimHeartbeat(item.segmentId, () =>
        this.transcribeSegment({ ...item, blobUrl: resolvedBlobUrl }),
      );
      await this.store.putTranscript({
        noteId: item.noteId,
        seq: item.seq,
        text: result.text,
        provider: result.provider,
        createdAt: this.now(),
      });
      await this.store.updateSegment(item.segmentId, { status: "done", error: undefined });
      // Réservation libérée : succès, plus personne n'a besoin d'y revenir.
      await this.store.releaseSegment(item.segmentId, this.tabId).catch(() => {});
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

  /**
   * INVARIANT (B1, revue sécurité) : aucun chemin de sortie de
   * `handleFailure` ne doit laisser `retryState` sans entrée pour un segment
   * encore vivant. Une entrée manquante est relue au prochain `runTick` comme
   * `dueAt = 0` — indiscernable d'un segment jamais essayé, donc "prêt
   * maintenant" : ni le backoff, ni le plafond `maxAmbiguousAttempts`, ni la
   * sentinelle `STOPPED` ne s'appliquent plus. Sans latence réseau, ça
   * rejoue le même transport des centaines de fois par seconde en boucle
   * microtâche pure (aucun `setTimeout` en jeu, donc rien pour la freiner) :
   * worker gelé en test, onglet figé et batterie vidée en vrai — précisément
   * le risque de stockage sous pression que la skill `audio-web` signale
   * pour Safari iOS (`QuotaExceededError`, `UnknownError`).
   *
   * D'où la règle : `state.nextRetryAt` est calculé et posé dans
   * `retryState` AVANT toute écriture dans le store, jamais après — une
   * panne en écrivant l'échec ne doit jamais, EN PLUS, faire sauter cette
   * protection. La seule suppression volontaire de l'entrée est le cas
   * "segment/note disparu" (`isMissingEntityError`) : légitime, puisque
   * "vivant" est justement la condition de l'invariant.
   *
   * RÉSERVATION (B2, deuxième passe de revue) : la libérer sur TOUT échec —
   * y compris retryable — a été essayé, et cassé le plafond de tentatives à
   * deux onglets : `retryState` est en mémoire, PAR ONGLET, alors qu'une
   * réservation libérée redevient immédiatement prenable par n'importe qui.
   * Après un premier échec, un autre onglet la reprenait donc aussitôt, sans
   * connaître ni le backoff ni le compteur "ambiguous" du premier — le
   * plafond de tentatives se retrouvait contourné à deux, en pratique
   * inexistant.
   *
   * La règle retenue : la réservation n'est PAS libérée sur un échec
   * retryable ou "ambiguous" pas encore épuisé — cet onglet la garde, c'est
   * lui qui réessaiera après son propre backoff (rafraîchie au besoin par un
   * futur passage dans `withClaimHeartbeat` si le prochain essai est encore
   * loin ; en pratique `STALE_THRESHOLD_MS` largement au-dessus de tout
   * backoff plausible ici la rend rarement nécessaire). Si cet onglet meurt
   * avant de réessayer, la réservation devient périmée toute seule et un
   * autre onglet la reprend alors — c'est le comportement voulu, symétrique
   * à celui d'un traitement interrompu. Elle N'EST libérée que sur arrêt
   * DÉFINITIF (`tier === "non-retryable"`) : plus aucun essai automatique
   * n'est prévu de ce côté, rien ne justifie de la garder — au contraire, la
   * libérer permet un réessai manuel (bouton Réessayer) ou par un autre
   * onglet sans attendre une péremption qui n'aurait plus aucun sens à
   * protéger.
   */
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

    // Posé avant l'écriture (voir l'invariant ci-dessus) : à partir d'ici,
    // TOUT retour de cette fonction respecte l'invariant sans y penser à
    // nouveau, sauf la suppression explicite et justifiée plus bas.
    state.nextRetryAt =
      tier === "non-retryable"
        ? STOPPED
        : this.now() +
          computeBackoffDelayMs(state.attempt, {
            baseDelayMs: this.baseDelayMs,
            maxDelayMs: this.maxDelayMs,
          });
    this.retryState.set(item.segmentId, state);

    try {
      await this.store.updateSegment(item.segmentId, { status: "error", error: message });
    } catch (writeErr) {
      if (isMissingEntityError(writeErr)) {
        // Segment/note réellement disparu (RGPD) : plus rien à retenter.
        // Retire l'entrée qu'on vient de poser — pas une violation de
        // l'invariant, "vivant" en est la condition même.
        this.retryState.delete(item.segmentId);
        return;
      }
      // Panne de stockage en écrivant l'échec lui-même : le statut réel du
      // segment reste ce qu'il était (l'écriture a échoué), mais
      // `retryState` porte déjà le prochain rendez-vous posé ci-dessus — le
      // prochain tick ne le retentera pas avant son heure. La réservation,
      // elle, n'est pas touchée non plus : elle expirera d'elle-même si
      // personne ne revient (voir l'argumentaire ci-dessus).
      return;
    }

    if (tier === "non-retryable") {
      // Arrêt définitif : voir l'argumentaire ci-dessus sur QUAND libérer.
      await this.store.releaseSegment(item.segmentId, this.tabId).catch(() => {});
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
