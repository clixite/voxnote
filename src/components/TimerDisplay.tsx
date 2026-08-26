"use client";

import { useEffect, useState } from "react";

import type { RecorderState } from "@/lib/recorder/machine";

import { formatDuration } from "./format";

export interface TimerDisplayProps {
  /** Durée cumulée hors pause exposée par `useRecorder` (événementielle, pas continue). */
  elapsedMs: number;
  state: RecorderState;
}

/** Fréquence du rafraîchissement visuel local. N'affecte jamais la mesure réelle du hook. */
const TICK_MS = 250;

/**
 * `useRecorder.elapsedMs` n'est recalculé qu'aux transitions d'état et aux
 * rotations de segment (toutes les ~5 minutes) : l'afficher tel quel ferait
 * un compteur qui « saute » au lieu de défiler. Ce composant ajoute un tick
 * visuel local ancré sur la dernière valeur connue, sans jamais recalculer
 * la durée lui-même — la source de vérité reste entièrement le hook.
 *
 * Le tick compte des intervalles de `TICK_MS`, jamais l'horloge murale
 * directement (`Date.now()`) : les règles React (composants purs pendant le
 * rendu) interdisent d'appeler une fonction impure pendant le rendu, et cette
 * approche a l'avantage d'être exactement déterministe avec les minuteurs
 * simulés des tests. `baseline` se resynchronise sur `elapsedMs` dès qu'il
 * change, via le motif React documenté d'ajustement d'état pendant le rendu
 * plutôt qu'un Effect (https://react.dev/learn/you-might-not-need-an-effect).
 *
 * Pas d'`aria-live` ici volontairement : un changement par seconde rendrait
 * la page inutilisable au lecteur d'écran. Les changements d'état et jalons
 * significatifs sont annoncés ailleurs (voir RecorderScreen), pas ce tick.
 */
export default function TimerDisplay({ elapsedMs, state }: TimerDisplayProps) {
  const isRunning = state === "recording";
  const [baseline, setBaseline] = useState(elapsedMs);
  const [ticks, setTicks] = useState(0);

  if (elapsedMs !== baseline) {
    setBaseline(elapsedMs);
    setTicks(0);
  }

  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => {
      setTicks((t) => t + 1);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [isRunning]);

  const displayMs = baseline + (isRunning ? ticks * TICK_MS : 0);

  return (
    <p className="font-mono text-5xl font-semibold tabular-nums tracking-tight text-slate-50">
      {formatDuration(displayMs)}
    </p>
  );
}
