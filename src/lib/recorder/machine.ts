/**
 * Machine à états pure de l'enregistreur : aucune dépendance à React, au DOM
 * ou à `MediaRecorder`. Testable isolément (voir machine.test.ts) — c'est le
 * cœur qui garantit qu'une transition invalide ne corrompt jamais l'état.
 *
 *        START            PAUSE
 *   idle ──────▶ recording ──────▶ paused
 *                   │  ▲              │
 *              STOP │  └── RESUME ────┘
 *                   ▼
 *                stopped
 *
 * `error` est atteignable depuis `idle`, `recording` et `paused` (permission
 * refusée, micro indisponible, type audio non supporté, plafond de durée...).
 * Depuis `error`, un nouveau `START` permet de relancer un essai. `stopped`
 * est terminal : aucun événement n'y est accepté.
 */
export type RecorderState = "idle" | "recording" | "paused" | "stopped" | "error";

export type RecorderEventType = "START" | "PAUSE" | "RESUME" | "STOP" | "ERROR";

const ALLOWED_EVENTS: Record<RecorderState, ReadonlySet<RecorderEventType>> = {
  idle: new Set(["START", "ERROR"]),
  recording: new Set(["PAUSE", "STOP", "ERROR"]),
  paused: new Set(["RESUME", "STOP", "ERROR"]),
  stopped: new Set(),
  error: new Set(["START"]),
};

const NEXT_STATE: Record<RecorderEventType, RecorderState> = {
  START: "recording",
  PAUSE: "paused",
  RESUME: "recording",
  STOP: "stopped",
  ERROR: "error",
};

/**
 * Refus explicite d'une transition invalide. Lever cette erreur plutôt que
 * de muter silencieusement l'état est le contrat : l'appelant garde l'état
 * précédent intact et décide quoi faire (ignorer, afficher un message...).
 */
export class InvalidRecorderTransitionError extends Error {
  constructor(
    public readonly from: RecorderState,
    public readonly event: RecorderEventType,
  ) {
    super(
      `Transition invalide : l'événement "${event}" n'est pas autorisé depuis l'état "${from}".`,
    );
    this.name = "InvalidRecorderTransitionError";
  }
}

export function canTransition(state: RecorderState, event: RecorderEventType): boolean {
  return ALLOWED_EVENTS[state].has(event);
}

/**
 * Calcule le prochain état. Lève `InvalidRecorderTransitionError` sans effet
 * de bord si la transition n'est pas autorisée depuis `state`.
 */
export function transition(state: RecorderState, event: RecorderEventType): RecorderState {
  if (!canTransition(state, event)) {
    throw new InvalidRecorderTransitionError(state, event);
  }
  return NEXT_STATE[event];
}
