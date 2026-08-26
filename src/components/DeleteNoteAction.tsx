"use client";

import { useState } from "react";

export interface DeleteNoteActionProps {
  noteId: string;
  /** Injectable pour les tests ; en production, `createDeleteNote(store)`. */
  onDelete: (noteId: string) => Promise<void>;
  /** Appelé après une suppression réussie, pour que le parent nettoie son état. */
  onDeleted: (noteId: string) => void;
}

type Phase = "idle" | "confirming" | "deleting" | "error";

const FALLBACK_ERROR_MESSAGE =
  "Impossible de supprimer cette note pour le moment. Réessaie dans un instant.";

/**
 * Action de suppression d'une note (C1) : irréversible, donc jamais en un
 * seul tap — un premier appui révèle une confirmation explicite avant toute
 * action. `onDelete` porte l'ordre contractuel serveur-puis-local (voir
 * deleteNote.ts) : si elle rejette, la note n'a pas bougé nulle part, et
 * cette action l'affiche en erreur plutôt que de la faire disparaître.
 */
export default function DeleteNoteAction({ noteId, onDelete, onDeleted }: DeleteNoteActionProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  async function handleConfirm() {
    setPhase("deleting");
    setErrorMessage(undefined);
    try {
      await onDelete(noteId);
      onDeleted(noteId);
    } catch (rawError) {
      setPhase("error");
      setErrorMessage(rawError instanceof Error ? rawError.message : FALLBACK_ERROR_MESSAGE);
    }
  }

  if (phase === "idle") {
    return (
      <button
        type="button"
        onClick={() => setPhase("confirming")}
        className="min-h-14 rounded-full border border-red-500/60 px-4 py-2 text-sm font-medium text-red-300 transition hover:bg-red-500/10"
      >
        Supprimer cette note
      </button>
    );
  }

  if (phase === "error") {
    return (
      <div
        role="alert"
        className="flex flex-col gap-3 rounded-lg border border-red-500/60 bg-red-500/10 px-4 py-3 text-sm text-red-200"
      >
        <p>
          <span className="font-semibold">Erreur : </span>
          {errorMessage}
        </p>
        <p className="text-red-300/90">
          Rien n&apos;a été supprimé : la note et son audio restent intacts.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleConfirm}
            className="min-h-14 rounded-full border border-red-400 px-4 py-2 text-sm font-medium text-red-100 hover:bg-red-500/20"
          >
            Réessayer
          </button>
          <button
            type="button"
            onClick={() => setPhase("idle")}
            className="min-h-14 rounded-full border border-slate-500 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-500/10"
          >
            Annuler
          </button>
        </div>
      </div>
    );
  }

  // "confirming" ou "deleting"
  const isDeleting = phase === "deleting";
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-red-500/60 bg-red-500/10 px-4 py-4 text-sm text-red-200">
      <p>
        <strong className="font-semibold">Supprimer définitivement cette note ?</strong>{" "}
        L&apos;audio (sur le serveur) et le texte (sur cet appareil) seront
        effacés. Cette action est irréversible.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleConfirm}
          disabled={isDeleting}
          className="min-h-14 rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isDeleting ? "Suppression…" : "Confirmer la suppression"}
        </button>
        <button
          type="button"
          onClick={() => setPhase("idle")}
          disabled={isDeleting}
          className="min-h-14 rounded-full border border-slate-500 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-slate-500/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Annuler
        </button>
      </div>
    </div>
  );
}
