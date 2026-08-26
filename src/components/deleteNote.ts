/**
 * Suppression d'une note : d'abord le serveur (`DELETE /api/notes/{id}`, qui
 * efface l'audio dans Vercel Blob), puis, SEULEMENT si ça a réussi, le local
 * (`NoteStore.deleteNote`, qui efface la note/ses segments/ses transcripts).
 *
 * Cet ordre est contractuel (voir `src/types/api.ts`, section
 * `DELETE /api/notes/[noteId]`) : les deux moitiés doivent réussir pour que
 * la suppression soit complète. Ne JAMAIS l'inverser — supprimer en local
 * avant de savoir si le serveur a réussi ferait disparaître la note de
 * l'écran en laissant son audio en ligne : une suppression qui *paraît*
 * complète sans l'être, pire qu'un échec visible.
 */
import type { ApiErrorBody } from "@/types/api";
import type { NoteStore } from "@/types/notes";

export type DeleteNoteFn = (noteId: string) => Promise<void>;

const NETWORK_ERROR_MESSAGE =
  "Impossible de contacter le serveur pour supprimer cette note. Vérifie ta connexion, puis réessaie.";
const GENERIC_ERROR_MESSAGE =
  "Impossible de supprimer cette note pour le moment. Réessaie dans un instant.";

/**
 * Fabrique la fonction de suppression réelle, liée à un `NoteStore` donné.
 * `fetchImpl` n'est là que pour l'injection en test (même esprit que
 * `getUserMedia` dans `useRecorder`) ; en production c'est `fetch` global.
 */
export function createDeleteNote(store: NoteStore, fetchImpl: typeof fetch = fetch): DeleteNoteFn {
  return async function deleteNote(noteId: string): Promise<void> {
    let response: Response;
    try {
      response = await fetchImpl(`/api/notes/${noteId}`, { method: "DELETE" });
    } catch {
      throw new Error(NETWORK_ERROR_MESSAGE);
    }

    if (!response.ok) {
      let message = GENERIC_ERROR_MESSAGE;
      try {
        const body = (await response.json()) as Partial<ApiErrorBody>;
        if (typeof body.message === "string" && body.message) message = body.message;
      } catch {
        // Réponse sans corps JSON exploitable : message générique.
      }
      throw new Error(message);
    }

    // Atteint seulement si le serveur a confirmé la suppression de l'audio.
    await store.deleteNote(noteId);
  };
}
