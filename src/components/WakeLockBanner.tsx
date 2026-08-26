"use client";

export interface WakeLockBannerProps {
  /** Le parent décide : indisponible/erreur ET une session est active. */
  show: boolean;
}

/**
 * Avertissement wake lock (skill audio-web, section Safari iOS) : affiché
 * uniquement quand le verrou d'écran ne peut pas être garanti pendant
 * l'enregistrement. Un bandeau permanent qu'on ignore ne sert à rien, donc
 * rien n'est rendu quand le verrou fonctionne.
 */
export default function WakeLockBanner({ show }: WakeLockBannerProps) {
  if (!show) return null;

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
    >
      <span aria-hidden="true" className="mt-0.5 text-base leading-none">
        ⚠
      </span>
      <p>
        <strong className="font-semibold">Garde l&apos;écran allumé.</strong>{" "}
        Ton appareil ne peut pas l&apos;empêcher automatiquement de se
        verrouiller pendant l&apos;enregistrement : s&apos;il s&apos;éteint,
        l&apos;enregistrement s&apos;arrête.
      </p>
    </div>
  );
}
