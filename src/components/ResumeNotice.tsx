"use client";

import { formatDuration } from "./format";

export interface ResumeNoticeInfo {
  noteId: string;
  createdAt: number;
  segmentCount: number;
  durationMs: number;
}

export interface ResumeNoticeProps {
  note: ResumeNoticeInfo;
  onResume: () => void;
  onFinish: () => void;
}

/**
 * Signale au montage une note laissée active par une session précédente
 * (refresh, crash, onglet fermé) — voir activeRecordingMarker.ts pour la
 * détection et RecorderScreen pour l'argumentaire complet de ce choix.
 *
 * « Reprendre » continue réellement cette note : `useRecorder.start(lang, { noteId })`
 * relit les segments existants et reprend la numérotation à la suite, sans
 * rien recréer. C'est le message le plus important de l'écran — un refresh
 * ou un crash pendant un enregistrement doit être un non-événement, pas un
 * moment de panique, donc le texte l'affirme sans détour : rien n'est perdu,
 * l'enregistrement continue là où il s'est arrêté. « Terminer » ne fait
 * disparaître que cet avertissement : les segments déjà enregistrés restent
 * tels quels en IndexedDB, prêts pour la suite du pipeline.
 */
export default function ResumeNotice({ note, onResume, onFinish }: ResumeNoticeProps) {
  const when = new Date(note.createdAt).toLocaleString("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
  });
  const duration = formatDuration(note.durationMs);
  const plural = note.segmentCount > 1;

  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-lg border border-sky-500/50 bg-sky-500/10 px-4 py-4 text-sm text-sky-100"
    >
      <p>
        <strong className="font-semibold">Enregistrement du {when} non terminé.</strong>{" "}
        {note.segmentCount} segment{plural ? "s" : ""} déjà enregistré
        {plural ? "s" : ""} et sauvegardé{plural ? "s" : ""} ({duration}). Rien
        n&apos;est perdu.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onResume}
          className="min-h-14 rounded-full bg-slate-50 px-4 py-2 text-sm font-medium text-slate-950"
        >
          Reprendre l&apos;enregistrement
        </button>
        <button
          type="button"
          onClick={onFinish}
          className="min-h-14 rounded-full border border-sky-400 px-4 py-2 text-sm font-medium text-sky-100"
        >
          Terminer cette note
        </button>
      </div>
      <p className="text-xs text-sky-200/80">
        Reprendre continue cet enregistrement exactement là où il s&apos;est
        arrêté : rien n&apos;est perdu. Terminer laisse ses segments tels
        quels, sans en ajouter d&apos;autres.
      </p>
    </div>
  );
}
