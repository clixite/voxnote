// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const listBlobsByPrefixMock = vi.hoisted(() => vi.fn());
const deleteBlobsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/blob/store", () => ({
  listBlobsByPrefix: listBlobsByPrefixMock,
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

describe("GET /api/cron/purge", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    listBlobsByPrefixMock.mockReset();
    deleteBlobsMock.mockReset();
  });

  it("CRON_SECRET absent côté serveur → 401, aucun appel Blob", async () => {
    vi.stubEnv("CRON_SECRET", "");

    const response = await GET(purgeRequest(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error).toBe("UNAUTHENTICATED");
    expect(listBlobsByPrefixMock).not.toHaveBeenCalled();
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
    expect(listBlobsByPrefixMock).not.toHaveBeenCalled();
  });

  it("CRON_SECRET correct → purge les blobs de plus de 7 jours, épargne les récents", async () => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    listBlobsByPrefixMock.mockResolvedValueOnce([
      { url: "https://blob/old", pathname: "audio/note-a/0", uploadedAt: daysAgo(10) },
      { url: "https://blob/recent", pathname: "audio/note-b/0", uploadedAt: daysAgo(1) },
    ]);
    deleteBlobsMock.mockResolvedValueOnce(undefined);

    const response = await GET(purgeRequest(`Bearer ${CRON_SECRET}`));

    expect(listBlobsByPrefixMock).toHaveBeenCalledWith("audio/");
    expect(deleteBlobsMock).toHaveBeenCalledWith(["https://blob/old"]);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ scanned: 2, deleted: 1 });
  });

  it("aucun blob de plus de 7 jours → ne supprime rien", async () => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    listBlobsByPrefixMock.mockResolvedValueOnce([
      { url: "https://blob/recent", pathname: "audio/note-b/0", uploadedAt: daysAgo(1) },
    ]);
    deleteBlobsMock.mockResolvedValueOnce(undefined);

    const response = await GET(purgeRequest(`Bearer ${CRON_SECRET}`));

    expect(deleteBlobsMock).toHaveBeenCalledWith([]);
    const json = await response.json();
    expect(json).toEqual({ scanned: 1, deleted: 0 });
  });

  it("erreur de configuration Blob (token absent) → 500 SERVER_MISCONFIGURED", async () => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    listBlobsByPrefixMock.mockRejectedValueOnce(
      new BlobConfigError("BLOB_READ_WRITE_TOKEN manquant."),
    );

    const response = await GET(purgeRequest(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("SERVER_MISCONFIGURED");
  });

  it("erreur inattendue du service Blob → 502 avec message français retryable", async () => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    listBlobsByPrefixMock.mockRejectedValueOnce(new Error("réseau indisponible"));

    const response = await GET(purgeRequest(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(502);
    const json = await response.json();
    expect(json.error).toBe("PROVIDER_UNAVAILABLE");
    expect(json.retryable).toBe(true);
  });
});
