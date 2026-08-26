"use client";

export interface ErrorBannerProps {
  /** Message français prêt à afficher tel quel (voir src/lib/recorder/errors.ts). */
  message: string | undefined;
  onRetry?: () => void;
}

/**
 * Affiche tel quel le message français fourni par le hook — jamais de
 * réécriture (CLAUDE.md #6). La porte de sortie (comment réactiver le
 * micro) est générique plutôt que conditionnée au type d'erreur exact : le
 * hook n'expose que `errorMessage` (texte), pas le code d'erreur d'origine
 * (`RecorderError.code`), donc on ne peut pas distinguer « refusé » de
 * « occupé » ou « aucun micro » sans analyser le texte du message, ce qui
 * serait fragile. Le conseil ci-dessous reste pertinent dans tous les cas
 * liés au micro, qui couvrent l'essentiel des erreurs possibles ici.
 */
export default function ErrorBanner({ message, onRetry }: ErrorBannerProps) {
  if (!message) return null;

  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-red-500/60 bg-red-500/10 px-4 py-3 text-sm text-red-200"
    >
      <p>
        <span className="font-semibold">Erreur : </span>
        {message}
      </p>
      <p className="text-red-300/90">
        Astuce : vérifie que le microphone est autorisé pour VoxNote dans les
        réglages de ton navigateur ou de ton appareil, puis réessaie.
      </p>
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
