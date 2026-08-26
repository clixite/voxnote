import { NextResponse } from "next/server";

import { BlobConfigError } from "@/lib/blob/env";
import { deleteBlobs, listBlobsByPrefix } from "@/lib/blob/store";
import { audioPrefixForNote, isValidNoteId } from "@/lib/blob/validation";
import type { ApiErrorBody, DeleteNoteResponseBody } from "@/types/api";

// Runtime Node explicite (déjà le défaut des route handlers), par cohérence
// avec `src/app/api/blob/upload-token/route.ts`, qui en dépend réellement
// (voir `src/lib/blob/store.ts`).
export const runtime = "nodejs";

function jsonError(body: ApiErrorBody, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

/**
 * Supprime tous les blobs audio d'une note, par préfixe `audio/{noteId}/`.
 * Voir `src/types/api.ts` (`DeleteNoteResponseBody`) pour le contrat complet.
 *
 * Le serveur liste et supprime lui-même : le client ne transmet aucune liste
 * d'URL. Se fier à une liste fournie par le client laisserait passer un blob
 * oublié, donc de l'audio orphelin — un manquement RGPD, pas un bug d'affichage.
 *
 * Idempotent : une note sans blob restant (déjà supprimée, ou jamais
 * uploadée) répond `{ deletedBlobs: 0 }` avec succès, jamais une erreur.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ noteId: string }> },
): Promise<NextResponse> {
  const { noteId } = await params;

  if (!isValidNoteId(noteId)) {
    return jsonError(
      {
        error: "BAD_REQUEST",
        message: "Identifiant de note invalide.",
        retryable: false,
      },
      400,
    );
  }

  try {
    const blobs = await listBlobsByPrefix(audioPrefixForNote(noteId));
    await deleteBlobs(blobs.map((blob) => blob.url));

    const response: DeleteNoteResponseBody = { deletedBlobs: blobs.length };
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof BlobConfigError) {
      return jsonError(
        {
          error: "SERVER_MISCONFIGURED",
          message: error.message,
          retryable: false,
        },
        500,
      );
    }
    return jsonError(
      {
        error: "PROVIDER_UNAVAILABLE",
        message:
          "Impossible de supprimer les fichiers audio pour le moment. Réessaie dans un instant.",
        retryable: true,
      },
      502,
    );
  }
}
