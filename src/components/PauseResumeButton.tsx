"use client";

import type { RecorderState } from "@/lib/recorder/machine";

export interface PauseResumeButtonProps {
  state: RecorderState;
  onPause: () => void;
  onResume: () => void;
}

/**
 * Contrôle pause/reprise, visuellement secondaire par rapport au bouton
 * d'arrêt (RecordButton) : le parent ne le rend que pendant une session
 * active (`recording` ou `paused`).
 */
export default function PauseResumeButton({ state, onPause, onResume }: PauseResumeButtonProps) {
  const isPaused = state === "paused";
  const label = isPaused ? "Reprendre l'enregistrement" : "Mettre en pause";

  return (
    <button
      type="button"
      onClick={isPaused ? onResume : onPause}
      className="flex h-14 min-h-14 min-w-14 items-center justify-center rounded-full border border-slate-600 bg-slate-900 px-6 text-base font-medium text-slate-100 transition hover:bg-slate-800"
    >
      {label}
    </button>
  );
}
