/**
 * Faux `MediaRecorder` réutilisable pour les tests (jsdom ne l'implémente
 * pas). Reproduit le comportement pertinent pour le moteur de segmentation :
 * - `start(timeslice)` accepte toujours un timeslice optionnel par fidélité à
 *   l'API réelle, mais `RecorderEngine` ne lui en passe plus aucun (C1 de la
 *   revue d'architecture — voir docs/ARCHITECTURE.md, section Segmentation) :
 *   `startCalls` garde une trace de chaque appel pour le vérifier ;
 * - `stop()` émet un morceau final (tout ce qui a été capté depuis `start()`)
 *   puis déclenche `onstop` de façon asynchrone (microtâche), comme un vrai
 *   `MediaRecorder` ; `stopCallCount` compte les appels ;
 * - `isTypeSupported` est piloté explicitement par les tests via
 *   `FakeMediaRecorder.supportedTypes`, jamais deviné.
 *
 * Réutilisé par le QA et les phases suivantes : garder ce fichier stable.
 */
export type FakeMediaRecorderState = "inactive" | "recording" | "paused";

export class FakeMediaRecorder {
  static supportedTypes = new Set<string>();
  static instances: FakeMediaRecorder[] = [];

  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supportedTypes.has(type);
  }

  /** Réservé aux tests : repart d'un état propre entre les cas de test. */
  static resetForTests(): void {
    FakeMediaRecorder.supportedTypes = new Set();
    FakeMediaRecorder.instances = [];
  }

  readonly stream: MediaStream;
  readonly mimeType: string;
  state: FakeMediaRecorderState = "inactive";

  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onpause: (() => void) | null = null;
  onresume: (() => void) | null = null;

  /** Si vrai, `stop()` déclenche `onerror` au lieu de `onstop` (test des erreurs). */
  failOnStop = false;

  /** Historique des arguments passés à `start()` — sert à vérifier C1 (jamais de timeslice). */
  readonly startCalls: Array<number | undefined> = [];
  /** Nombre d'appels à `stop()` — sert à vérifier C4 (chaque instance arrêtée une fois). */
  stopCallCount = 0;

  private timesliceTimer: ReturnType<typeof setInterval> | undefined;
  private chunkSeq = 0;

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    this.stream = stream;
    this.mimeType = options?.mimeType ?? "";
    FakeMediaRecorder.instances.push(this);
  }

  start(timesliceMs?: number): void {
    this.startCalls.push(timesliceMs);
    if (this.state !== "inactive") {
      throw new DOMException("Le MediaRecorder est déjà actif.", "InvalidStateError");
    }
    this.state = "recording";
    this.chunkSeq = 0;
    if (timesliceMs) {
      this.timesliceTimer = setInterval(() => this.emitChunk(), timesliceMs);
    }
  }

  pause(): void {
    if (this.state !== "recording") return;
    this.state = "paused";
    this.onpause?.();
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.state = "recording";
    this.onresume?.();
  }

  requestData(): void {
    this.emitChunk();
  }

  stop(): void {
    this.stopCallCount += 1;
    if (this.state === "inactive") return;
    if (this.timesliceTimer !== undefined) {
      clearInterval(this.timesliceTimer);
      this.timesliceTimer = undefined;
    }
    // Morceau final : un vrai MediaRecorder émet toujours un dernier
    // `dataavailable` avant `stop`, avec le reliquat du buffer interne.
    this.emitChunk();
    this.state = "inactive";
    queueMicrotask(() => {
      if (this.failOnStop) {
        this.onerror?.(new Event("error"));
      } else {
        this.onstop?.();
      }
    });
  }

  private emitChunk(): void {
    this.chunkSeq += 1;
    const data = new Blob([`fake-chunk-${this.chunkSeq}`], { type: this.mimeType });
    this.ondataavailable?.({ data } as BlobEvent);
  }
}
