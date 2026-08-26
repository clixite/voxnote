"use client";

export interface OfflineQueueBannerProps {
  /** Le parent décide : hors ligne ET au moins un segment concerné (voir useUploadQueue). */
  show: boolean;
}

/**
 * Bandeau de réassurance hors-ligne (ticket P3-5) : le message qui compte
 * n'est pas "tu es hors-ligne" mais "rien n'est perdu, ça repart tout seul" —
 * même esprit que WakeLockBanner/OtherTabNotice, purement informatif.
 */
export default function OfflineQueueBanner({ show }: OfflineQueueBannerProps) {
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
        <strong className="font-semibold">Pas de connexion internet.</strong>{" "}
        Pas d&apos;inquiétude : tes passages déjà enregistrés restent en
        sécurité sur cet appareil. L&apos;envoi et la transcription reprendront
        tout seuls dès que la connexion reviendra.
      </p>
    </div>
  );
}
