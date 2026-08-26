"use client";

import type { RecorderErrorCode } from "@/lib/recorder/errors";

export interface ErrorBannerProps {
  /** Message français prêt à afficher tel quel (voir src/lib/recorder/errors.ts). */
  message: string | undefined;
  /** Code discriminant de l'erreur, pour choisir un conseil adapté (voir ADVICE_BY_CODE). */
  code?: RecorderErrorCode;
  onRetry?: () => void;
}

/**
 * Conseil affiché sous le message d'erreur, adapté au code plutôt que
 * générique : mieux vaut aucun conseil qu'un conseil qui ne correspond pas à
 * la situation réelle. Seuls les codes où une action concrète et fiable
 * existe ont une entrée ; les autres (contrainte non supportée, contexte non
 * sécurisé, plafond de durée, note introuvable, type non supporté, inconnu…)
 * n'affichent que le message du hook.
 */
const ADVICE_BY_CODE: Partial<Record<RecorderErrorCode, string>> = {
  "permission-denied":
    "Autorise le micro pour VoxNote : ouvre les réglages de ce site dans ton navigateur (l'icône à côté de l'adresse) ou les réglages micro de ton appareil, puis appuie sur Réessayer.",
  "no-microphone":
    "Aucun micro n'est détecté. Branche un micro, ou vérifie que ton appareil en a bien un d'activé, puis réessaie.",
  "microphone-busy":
    "Une autre application (ou un autre onglet) utilise déjà le micro. Ferme-la, puis réessaie.",
};

/**
 * Affiche tel quel le message français fourni par le hook — jamais de
 * réécriture (CLAUDE.md #6). Le conseil, lui, appartient entièrement à ce
 * composant : construit à partir du `code` discriminant exposé par le hook,
 * jamais en analysant le texte du message (qui peut être reformulé sans
 * préavis pour l'utilisateur, comme l'a montré le passage au tutoiement).
 */
export default function ErrorBanner({ message, code, onRetry }: ErrorBannerProps) {
  if (!message) return null;
  const advice = code ? ADVICE_BY_CODE[code] : undefined;

  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-red-500/60 bg-red-500/10 px-4 py-3 text-sm text-red-200"
    >
      <p>
        <span className="font-semibold">Erreur : </span>
        {message}
      </p>
      {advice && <p className="text-red-300/90">{advice}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-14 self-start rounded-full border border-red-400 px-4 py-2 text-sm font-medium text-red-100 hover:bg-red-500/20"
        >
          Réessayer
        </button>
      )}
    </div>
  );
}
