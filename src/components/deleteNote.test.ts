import { describe, expect, it, vi } from "vitest";

import { createFakeNoteStore } from "@/lib/recorder/test-utils";

import { createDeleteNote } from "./deleteNote";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("createDeleteNote", () => {
  it("supprime en local seulement après un succès serveur, dans cet ordre", async () => {
    const store = createFakeNoteStore();
    const note = await store.createNote({ lang: "fr" });
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method} ${input}`);
      return jsonResponse(200, { deletedBlobs: 1 });
    });

    await createDeleteNote(store, fetchImpl as unknown as typeof fetch)(note.id);

    expect(calls).toEqual([`DELETE /api/notes/${note.id}`]);
    expect(await store.getNote(note.id)).toBeUndefined();
  });

  it("ne supprime PAS en local si le serveur échoue, et rejette avec le message du serveur", async () => {
    const store = createFakeNoteStore();
    const note = await store.createNote({ lang: "fr" });
    const fetchImpl = vi.fn(async () =>
      jsonResponse(502, {
        error: "PROVIDER_UNAVAILABLE",
        message: "Impossible de supprimer les fichiers audio pour le moment.",
        retryable: true,
      }),
    );

    await expect(createDeleteNote(store, fetchImpl as unknown as typeof fetch)(note.id)).rejects.toThrow(
      /impossible de supprimer les fichiers audio/i,
    );

    expect(await store.getNote(note.id)).toBeDefined();
  });

  it("ne supprime PAS en local si la requête échoue avant même d'atteindre le serveur", async () => {
    const store = createFakeNoteStore();
    const note = await store.createNote({ lang: "fr" });
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(createDeleteNote(store, fetchImpl as unknown as typeof fetch)(note.id)).rejects.toThrow();
    expect(await store.getNote(note.id)).toBeDefined();
  });

  it("retombe sur un message générique si la réponse d'erreur n'a pas de corps JSON exploitable", async () => {
    const store = createFakeNoteStore();
    const note = await store.createNote({ lang: "fr" });
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("pas de corps");
      },
    })) as unknown as typeof fetch;

    await expect(createDeleteNote(store, fetchImpl)(note.id)).rejects.toThrow(/réessaie/i);
    expect(await store.getNote(note.id)).toBeDefined();
  });
});
