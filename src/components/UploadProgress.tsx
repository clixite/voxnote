"use client";

import type { NoteProgress } from "@/lib/upload/noteRollup";
import type { QueueGlobalStatus } from "@/lib/upload/queue";

export interface UploadProgressProps {
  /** `undefined` : pas encore de note à suivre, ou aucun segment (rien à afficher). */
  progress: NoteProgress | undefined;
  globalStatus: QueueGlobalStatus;
  onRetry: (segmentId: string) => void;
}

const STATUS_LABEL: Record<QueueGlobalStatus, string> = {
  idle: "Terminé",
  syncing: "Envoi en cours",
  offline: "En pause (hors ligne)",
  error: "En erreur",
};

const STATUS_BADGE_CLASSES: Record<QueueGlobalStatus, string> = {
  idle: "border-emerald-500/60 bg-emerald-500/10 text-emerald-200",
  syncing: "border-sky-500/60 bg-sky-500/10 text-sky-200",
  offline: "border-amber-500/60 bg-amber-500/10 text-amber-200",
  error: "border-red-500/60 bg-red-500/10 text-red-200",
};

/**
 * Progression d'envoi/transcription d'une note (ticket P3-5) : combien de
 * segments envoyés, combien transcrits, sur combien au total, plus un état
 * global lisible d'un coup d'œil et le détail des erreurs avec un bouton
 * « Réessayer ». Volontairement statique (pas d'`aria-live`) : la progression
 * change trop souvent pour être annoncée à chaque changement — voir
 * RecorderScreen, qui annonce séparément les seuls changements d'état
 * significatifs.
 */
export default function UploadProgress({ progress, globalStatus, onRetry }: UploadProgressProps) {
  if (!progress || progress.total === 0) return null;

  return (
    <div
      data-testid="upload-progress"
      className="flex w-full flex-col gap-3 rounded-lg border border-slate-700 bg-slate-800/40 px-4 py-3 text-sm text-slate-300"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-slate-200">Envoi et transcription</span>
        <span
          className={`rounded-full border px-3 py-1 text-xs font-medium ${STATUS_BADGE_CLASSES[globalStatus]}`}
        >
          {STATUS_LABEL[globalStatus]}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs text-slate-400">
        <div>
          <dt>Envoyés</dt>
          <dd className="text-base text-slate-200">
            {progress.uploadedCount} / {progress.total}
          </dd>
        </div>
        <div>
          <dt>Transcrits</dt>
          <dd className="text-base text-slate-200">
            {progress.transcribedCount} / {progress.total}
          </dd>
        </div>
      </dl>

      {progress.errorSegments.length > 0 && (
        <ul className="flex flex-col gap-2">
          {progress.errorSegments.map((segment) => (
            <li
              key={segment.segmentId}
              className="flex flex-col gap-2 rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-red-200"
            >
              <p>
                <span className="font-semibold">Passage {segment.seq + 1} : </span>
                {segment.message}
              </p>
              <button
                type="button"
                onClick={() => onRetry(segment.segmentId)}
                className="min-h-14 self-start rounded-full border border-red-400 px-4 text-sm font-medium text-red-100 hover:bg-red-500/20"
              >
                Réessayer
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
