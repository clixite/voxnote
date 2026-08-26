"use client";

import type { RecorderState } from "@/lib/recorder/machine";

export interface RecordButtonProps {
  state: RecorderState;
  /** `true` si aucun mimeType audio n'est supporté par ce navigateur. */
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
}

const ACTIVE_STATES: ReadonlySet<RecorderState> = new Set(["recording", "paused"]);

/**
 * Bouton principal de l'écran : démarre l'enregistrement, puis devient le
 * contrôle d'arrêt (y compris pendant une pause — c'est le bouton
 * pause/reprise, visuellement secondaire, qui gère l'autre aller-retour).
 * Le nom accessible change avec l'état : `getByRole("button", { name: /enregistrer/i })`
 * ne matche qu'à l'arrêt, `/arrêter/i` pendant l'enregistrement ou la pause.
 */
export default function RecordButton({ state, disabled, onStart, onStop }: RecordButtonProps) {
  const isActive = ACTIVE_STATES.has(state);
  const label = isActive ? "Arrêter l'enregistrement" : "Enregistrer";

  return (
    <button
      type="button"
      onClick={isActive ? onStop : onStart}
      disabled={disabled}
      className={
        "flex h-40 w-40 min-h-14 min-w-14 flex-col items-center justify-center gap-2 rounded-full shadow-inner ring-1 transition disabled:cursor-not-allowed disabled:opacity-60 sm:h-48 sm:w-48 " +
        (isActive
          ? "bg-red-600 text-white ring-red-400"
          : "bg-slate-50 text-slate-950 ring-slate-300")
      }
    >
      {isActive ? <StopIcon className="h-12 w-12" /> : <MicIcon className="h-12 w-12" />}
      <span className="text-lg font-medium">{label}</span>
    </button>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </svg>
  );
}

function StopIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}
