// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const listBlobPagesByPrefixMock = vi.hoisted(() => vi.fn());
const deleteBlobsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/blob/store", () => ({
  listBlobPagesByPrefix: listBlobPagesByPrefixMock,
  deleteBlobs: deleteBlobsMock,
}));

import { BlobConfigError } from "@/lib/blob/env";

import { GET } from "./route";

const CRON_SECRET = "test-cron-secret";

function purgeRequest(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new Request("http://localhost/api/cron/purge", { headers });
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function blob(url: string, pathname: string, uploadedAt: Date) {
  return { url, pathname, uploadedAt };
}

/** Doublon de `listBlobPagesByPrefix` : un générateur async qui yield chaque page donnée. */
function pagesOf(
  ...pages: Array<ReturnType<typeof blob>[]>
): () => AsyncGenerator<ReturnType<typeof blob>[]> {
  return async function* () {
    for (const page of pages) yield page;
  };
}

/** Comme `pagesOf`, mais lève `error` après avoir cédé les pages données. */
function pagesThenFail(
  error: unknown,
  ...pages: Array<ReturnType<typeof blob>[]>
): () => AsyncGenerator<ReturnType<typeof blob>[]> {
  return async function* () {
    for (const page of pages) yield page;
    throw error;
  };
}

describe("GET /api/cron/purge", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    listBlobPagesByPrefixMock.mockReset();
    deleteBlobsMock.mockReset();
  });

  it("CRON_SECRET absent côté serveur → 401, aucun appel Blob", async () => {
    vi.stubEnv("CRON_SECRET", "");

    const response = await GET(purgeRequest(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error).toBe("UNAUTHENTICATED");
    expect(listBlobPagesByPrefixMock).not.toHaveBeenCalled();
  });

  it("en-tête Authorization absent → 401", async () => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);

    const response = await GET(purgeRequest());

    expect(response.status).toBe(401);
  });

  it("CRON_SECRET fourni mais incorrect → 401", async () => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);

    const response = await GET(purgeRequest("Bearer mauvais-secret"));

    expect(response.status).toBe(401);
    expect(listBlobPagesByPrefixMock).not.toHaveBeenCalled();
  });

  it("CRON_SECRET fourni mais de longueur différente → 401 (pas de crash timingSafeEqual)", async () => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);

    const response = await GET(purgeRequest("Bearer court"));

    expect(response.status).toBe(401);
  });

  it("CRON_SECRET correct → purge les blobs de plus de 7 jours, épargne les récents", async () => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    listBlobPagesByPrefixMock.mockImplementation(
      pagesOf([
        blob("https://blob/old", "audio/note-a/0", daysAgo(10)),
        blob("https://blob/recent", "audio/note-b/0", daysAgo(1)),
      ]),
    );
    deleteBlobsMock.mockResolvedValueOnce(undefined);

    const response = await GET(purgeRequest(`Bearer ${CRON_SECRET}`));

    expect(listBlobPagesByPrefixMock).toHaveBeenCalledWith("audio/");
    expect(deleteBlobsMock).toHaveBeenCalledWith(["https://blob/old"]);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ scanned: 2, deleted: 1 });
  });

  it("aucun blob de plus de 7 jours → ne supprime rien, deleteBlobs jamais appelé", async () => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    listBlobPagesByPrefixMock.mockImplementation(
      pagesOf([blob("https://blob/recent", "audio/note-b/0", daysAgo(1))]),
    );

    const response = await GET(purgeRequest(`Bearer ${CRON_SECRET}`));

    expect(deleteBlobsMock).not.toHaveBeenCalled();
    const json = await response.json();
    expect(json).toEqual({ scanned: 1, deleted: 0 });
  });

  it("traite chaque page au fur et à mesure (plusieurs appels à deleteBlobs, un par page)", async () => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    listBlobPagesByPrefixMock.mockImplementation(
      pagesOf(
        [blob("u0", "audio/note-a/0", daysAgo(10))],
        [blob("u1", "audio/note-b/0", daysAgo(10))],
      ),
    );
    deleteBlobsMock.mockResolvedValue(undefined);

    const response = await GET(purgeRequest(`Bearer ${CRON_SECRET}`));

    expect(deleteBlobsMock).toHaveBeenCalledTimes(2);
    expect(deleteBlobsMock).toHaveBeenNthCalledWith(1, ["u0"]);
    expect(deleteBlobsMock).toHaveBeenNthCalledWith(2, ["u1"]);
    const json = await response.json();
    expect(json).toEqual({ scanned: 2, deleted: 2 });
  });

  it("échec de suppression sur une page → les pages suivantes sont quand même traitées, 200 avec le décompte réel", async () => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    listBlobPagesByPrefixMock.mockImplementation(
      pagesOf(
        [blob("u0", "audio/note-a/0", daysAgo(10))],
        [blob("u1", "audio/note-b/0", daysAgo(10))],
      ),
    );
    deleteBlobsMock
      .mockRejectedValueOnce(new Error("échec suppression page 1"))
      .mockResolvedValueOnce(undefined);

    const response = await GET(purgeRequest(`Bearer ${CRON_SECRET}`));

    expect(deleteBlobsMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    const json = await response.json();
    // Page 1 : suppression échouée, donc pas comptée dans `deleted`.
    // Page 2 : suppression réussie, comptée. Les deux pages sont `scanned`.
    expect(json).toEqual({ scanned: 2, deleted: 1 });
  });

  it("le scan échoue après la première page → 200 avec le travail déjà accompli, pas 502", async () => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    listBlobPagesByPrefixMock.mockImplementation(
      pagesThenFail(
        new Error("service indisponible"),
        [blob("u0", "audio/note-a/0", daysAgo(10))],
      ),
    );
    deleteBlobsMock.mockResolvedValueOnce(undefined);

    const response = await GET(purgeRequest(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ scanned: 1, deleted: 1 });
  });

  it("erreur de configuration Blob (token absent) → 500 SERVER_MISCONFIGURED, même après des pages traitées", async () => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    listBlobPagesByPrefixMock.mockImplementation(
      pagesThenFail(new BlobConfigError("BLOB_READ_WRITE_TOKEN manquant.")),
    );

    const response = await GET(purgeRequest(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("SERVER_MISCONFIGURED");
  });

  it("échec dès la première page (rien scanné) → 502 avec message français retryable", async () => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    listBlobPagesByPrefixMock.mockImplementation(
      pagesThenFail(new Error("réseau indisponible")),
    );

    const response = await GET(purgeRequest(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(502);
    const json = await response.json();
    expect(json.error).toBe("PROVIDER_UNAVAILABLE");
    expect(json.retryable).toBe(true);
  });
});
