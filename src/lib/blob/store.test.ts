// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const listMock = vi.hoisted(() => vi.fn());
const delMock = vi.hoisted(() => vi.fn());
const headMock = vi.hoisted(() => vi.fn());
const getMock = vi.hoisted(() => vi.fn());
const handleUploadMock = vi.hoisted(() => vi.fn());

vi.mock("@vercel/blob", () => ({
  list: listMock,
  del: delMock,
  head: headMock,
  get: getMock,
}));

vi.mock("@vercel/blob/client", () => ({
  handleUpload: handleUploadMock,
}));

import { BlobConfigError } from "./env";
import {
  deleteBlobs,
  generateUploadToken,
  getBlobStream,
  headBlob,
  listBlobPagesByPrefix,
  listBlobsByPrefix,
} from "./store";

const TOKEN = "vercel_blob_rw_teststoreid_secretsecret";

describe("listBlobsByPrefix", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    listMock.mockReset();
  });

  it("lève BlobConfigError sans appeler le SDK si le token est absent", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");

    await expect(listBlobsByPrefix("audio/note-1/")).rejects.toThrow(
      BlobConfigError,
    );
    expect(listMock).not.toHaveBeenCalled();
  });

  it("passe le prefix et le token, et renvoie les blobs d'une seule page", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", TOKEN);
    const uploadedAt = new Date("2026-01-01T00:00:00Z");
    listMock.mockResolvedValueOnce({
      blobs: [
        { url: "https://blob/audio/note-1/0", pathname: "audio/note-1/0", uploadedAt, size: 10, downloadUrl: "x", etag: "e" },
      ],
      hasMore: false,
    });

    const files = await listBlobsByPrefix("audio/note-1/");

    expect(listMock).toHaveBeenCalledWith({
      prefix: "audio/note-1/",
      cursor: undefined,
      token: TOKEN,
    });
    expect(files).toEqual([
      { url: "https://blob/audio/note-1/0", pathname: "audio/note-1/0", uploadedAt },
    ]);
  });

  it("suit la pagination (cursor) jusqu'à hasMore: false", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", TOKEN);
    const uploadedAt = new Date("2026-01-01T00:00:00Z");
    listMock
      .mockResolvedValueOnce({
        blobs: [
          { url: "u0", pathname: "audio/note-1/0", uploadedAt, size: 1, downloadUrl: "x", etag: "e" },
        ],
        hasMore: true,
        cursor: "page-2",
      })
      .mockResolvedValueOnce({
        blobs: [
          { url: "u1", pathname: "audio/note-1/1", uploadedAt, size: 1, downloadUrl: "x", etag: "e" },
        ],
        hasMore: false,
      });

    const files = await listBlobsByPrefix("audio/note-1/");

    expect(listMock).toHaveBeenNthCalledWith(1, {
      prefix: "audio/note-1/",
      cursor: undefined,
      token: TOKEN,
    });
    expect(listMock).toHaveBeenNthCalledWith(2, {
      prefix: "audio/note-1/",
      cursor: "page-2",
      token: TOKEN,
    });
    expect(files.map((f) => f.url)).toEqual(["u0", "u1"]);
  });
});

describe("listBlobPagesByPrefix", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    listMock.mockReset();
  });

  it("lève BlobConfigError avant le premier appel réseau si le token est absent", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");

    const iterator = listBlobPagesByPrefix("audio/")[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(BlobConfigError);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("expose chaque page séparément, sans attendre la dernière", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", TOKEN);
    const uploadedAt = new Date("2026-01-01T00:00:00Z");
    listMock
      .mockResolvedValueOnce({
        blobs: [{ url: "u0", pathname: "audio/note-1/0", uploadedAt, size: 1, downloadUrl: "x", etag: "e" }],
        hasMore: true,
        cursor: "page-2",
      })
      .mockResolvedValueOnce({
        blobs: [{ url: "u1", pathname: "audio/note-1/1", uploadedAt, size: 1, downloadUrl: "x", etag: "e" }],
        hasMore: false,
      });

    const pages: string[][] = [];
    for await (const page of listBlobPagesByPrefix("audio/")) {
      pages.push(page.map((f) => f.url));
    }

    expect(pages).toEqual([["u0"], ["u1"]]);
  });
});

describe("deleteBlobs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delMock.mockReset();
  });

  it("ne fait aucun appel réseau pour une liste vide", async () => {
    await deleteBlobs([]);
    expect(delMock).not.toHaveBeenCalled();
  });

  it("lève BlobConfigError sans appeler le SDK si le token est absent (liste non vide)", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");

    await expect(deleteBlobs(["https://blob/audio/note-1/0"])).rejects.toThrow(
      BlobConfigError,
    );
    expect(delMock).not.toHaveBeenCalled();
  });

  it("supprime les URL données avec le token, en un seul lot sous le plafond", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", TOKEN);
    delMock.mockResolvedValueOnce(undefined);

    await deleteBlobs(["u0", "u1"]);

    expect(delMock).toHaveBeenCalledTimes(1);
    expect(delMock).toHaveBeenCalledWith(["u0", "u1"], { token: TOKEN });
  });

  it("découpe en lots de 250 URL au plus", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", TOKEN);
    delMock.mockResolvedValue(undefined);
    const urls = Array.from({ length: 620 }, (_, i) => `u${i}`);

    await deleteBlobs(urls);

    expect(delMock).toHaveBeenCalledTimes(3);
    expect(delMock).toHaveBeenNthCalledWith(1, urls.slice(0, 250), { token: TOKEN });
    expect(delMock).toHaveBeenNthCalledWith(2, urls.slice(250, 500), { token: TOKEN });
    expect(delMock).toHaveBeenNthCalledWith(3, urls.slice(500, 620), { token: TOKEN });
  });

  it("un lot qui échoue rejette, mais les lots précédents ont déjà été appelés", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", TOKEN);
    delMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("service indisponible"));
    const urls = Array.from({ length: 500 }, (_, i) => `u${i}`);

    await expect(deleteBlobs(urls)).rejects.toThrow("service indisponible");
    expect(delMock).toHaveBeenCalledTimes(2);
  });
});

describe("headBlob", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    headMock.mockReset();
  });

  it("lève BlobConfigError sans appeler le SDK si le token est absent", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");

    await expect(headBlob("audio/note-1/0")).rejects.toThrow(BlobConfigError);
    expect(headMock).not.toHaveBeenCalled();
  });

  it("transmet le token explicitement à head", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", TOKEN);
    headMock.mockResolvedValueOnce({ size: 42, pathname: "audio/note-1/0" });

    const result = await headBlob("audio/note-1/0");

    expect(headMock).toHaveBeenCalledWith("audio/note-1/0", { token: TOKEN });
    expect(result).toEqual({ size: 42, pathname: "audio/note-1/0" });
  });
});

describe("getBlobStream", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    getMock.mockReset();
  });

  it("lève BlobConfigError sans appeler le SDK si le token est absent", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");

    await expect(getBlobStream("audio/note-1/0")).rejects.toThrow(BlobConfigError);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("force access: private et transmet le token", async () => {
    // `access` n'appartient pas au type accepté par `getBlobStream`
    // (`Omit<GetCommandOptions, "access" | "token">`) : impossible de le
    // paramétrer autrement qu'à "private" à la compilation. Ce test vérifie
    // seulement la valeur transmise au SDK, la garantie de type étant déjà
    // assurée par la signature elle-même.
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", TOKEN);
    getMock.mockResolvedValueOnce({ statusCode: 200 });

    await getBlobStream("audio/note-1/0", { useCache: false });

    expect(getMock).toHaveBeenCalledWith("audio/note-1/0", {
      useCache: false,
      access: "private",
      token: TOKEN,
    });
  });
});

describe("generateUploadToken", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    handleUploadMock.mockReset();
  });

  it("lève BlobConfigError sans appeler le SDK si le token est absent", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");

    await expect(
      generateUploadToken({
        request: new Request("http://localhost/api/blob/upload-token"),
        body: { type: "blob.generate-client-token", payload: { pathname: "p", multipart: false, clientPayload: null } },
        onBeforeGenerateToken: async () => ({}),
      }),
    ).rejects.toThrow(BlobConfigError);
    expect(handleUploadMock).not.toHaveBeenCalled();
  });

  it("transmet le token explicitement à handleUpload", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", TOKEN);
    handleUploadMock.mockResolvedValueOnce({
      type: "blob.generate-client-token",
      clientToken: "fake-token",
    });

    const onBeforeGenerateToken = async () => ({});
    const request = new Request("http://localhost/api/blob/upload-token");
    const body = {
      type: "blob.generate-client-token" as const,
      payload: { pathname: "audio/note-1/0", multipart: false, clientPayload: null },
    };

    const result = await generateUploadToken({ request, body, onBeforeGenerateToken });

    expect(handleUploadMock).toHaveBeenCalledWith({
      request,
      body,
      onBeforeGenerateToken,
      token: TOKEN,
    });
    expect(result).toEqual({ type: "blob.generate-client-token", clientToken: "fake-token" });
  });
});
