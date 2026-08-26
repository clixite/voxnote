"use client";

export interface LevelMeterProps {
  /** Niveau normalisé 0..1, tel qu'exposé par `useRecorder`. */
  level: number;
}

const BAR_COUNT = 8;

/**
 * VU-mètre sobre : confirme « ça capte », sans prétendre à la précision.
 * Décoratif pour les lecteurs d'écran (`aria-hidden`) — l'information qui
 * compte (enregistrement en cours ou non) est déjà portée par le nom
 * accessible du bouton principal et par les annonces d'état, pas par ce
 * rendu qui changerait à chaque frame.
 *
 * Le niveau se lit au nombre de barres remplies ET à leur remplissage plein
 * vs. contour seul, jamais à la couleur seule.
 */
export default function LevelMeter({ level }: LevelMeterProps) {
  const clamped = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  const filledCount = Math.round(clamped * BAR_COUNT);

  return (
    <div aria-hidden="true" className="flex h-10 items-end gap-1">
      {Array.from({ length: BAR_COUNT }, (_, index) => {
        const isFilled = index < filledCount;
        return (
          <span
            key={index}
            data-filled={isFilled}
            className={
              "w-2 rounded-sm border transition-all " +
              (isFilled ? "border-sky-300 bg-sky-400" : "border-slate-600 bg-transparent")
            }
            style={{ height: `${((index + 1) / BAR_COUNT) * 100}%` }}
          />
        );
      })}
    </div>
  );
}
