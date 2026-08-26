// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const listBlobsByPrefixMock = vi.hoisted(() => vi.fn());
const deleteBlobsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/blob/store", () => ({
  listBlobsByPrefix: listBlobsByPrefixMock,
  deleteBlobs: deleteBlobsMock,
}));

import { BlobConfigError } from "@/lib/blob/env";

import { DELETE } from "./route";

const NOTE_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function deleteRequest(): Request {
  return new Request(`http://localhost/api/notes/${NOTE_ID}`, {
    method: "DELETE",
  });
}

function context(noteId: string) {
  return { params: Promise.resolve({ noteId }) };
}

describe("DELETE /api/notes/[noteId]", () => {
  afterEach(() => {
    listBlobsByPrefixMock.mockReset();
    deleteBlobsMock.mockReset();
  });

  it("noteId malformé → 400 BAD_REQUEST, aucun appel Blob", async () => {
    const response = await DELETE(deleteRequest(), context("pas-un-uuid"));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("BAD_REQUEST");
    expect(listBlobsByPrefixMock).not.toHaveBeenCalled();
    expect(deleteBlobsMock).not.toHaveBeenCalled();
  });

  it("supprime tous les blobs listés sous le préfixe audio/{noteId}/, sans en oublier un", async () => {
    listBlobsByPrefixMock.mockResolvedValueOnce([
      { url: "https://blob/audio/note/0", pathname: `audio/${NOTE_ID}/0`, uploadedAt: new Date() },
      { url: "https://blob/audio/note/1", pathname: `audio/${NOTE_ID}/1`, uploadedAt: new Date() },
      { url: "https://blob/audio/note/2", pathname: `audio/${NOTE_ID}/2`, uploadedAt: new Date() },
    ]);
    deleteBlobsMock.mockResolvedValueOnce(undefined);

    const response = await DELETE(deleteRequest(), context(NOTE_ID));

    expect(listBlobsByPrefixMock).toHaveBeenCalledWith(`audio/${NOTE_ID}/`);
    expect(deleteBlobsMock).toHaveBeenCalledWith([
      "https://blob/audio/note/0",
      "https://blob/audio/note/1",
      "https://blob/audio/note/2",
    ]);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ deletedBlobs: 3 });
  });

  it("note déjà supprimée (aucun blob restant) → succès idempotent, pas une erreur", async () => {
    listBlobsByPrefixMock.mockResolvedValueOnce([]);
    deleteBlobsMock.mockResolvedValueOnce(undefined);

    const response = await DELETE(deleteRequest(), context(NOTE_ID));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ deletedBlobs: 0 });
    // Liste vide : deleteBlobs peut être appelé avec [] mais ne doit déclencher
    // aucune requête réseau — vérifié séparément dans store.test.ts.
  });

  it("erreur de configuration Blob (token absent) → 500 SERVER_MISCONFIGURED", async () => {
    listBlobsByPrefixMock.mockRejectedValueOnce(
      new BlobConfigError("BLOB_READ_WRITE_TOKEN manquant."),
    );

    const response = await DELETE(deleteRequest(), context(NOTE_ID));

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("SERVER_MISCONFIGURED");
  });

  it("erreur inattendue du service Blob → 502 avec message français retryable", async () => {
    listBlobsByPrefixMock.mockRejectedValueOnce(new Error("réseau indisponible"));

    const response = await DELETE(deleteRequest(), context(NOTE_ID));

    expect(response.status).toBe(502);
    const json = await response.json();
    expect(json.error).toBe("PROVIDER_UNAVAILABLE");
    expect(json.retryable).toBe(true);
  });
});
