// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob", () => ({
  get: vi.fn(),
}));

import { get } from "@vercel/blob";

import { downloadBlobAudio } from "./audio-source";
import { TranscriptionError } from "./errors";

function fakeStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        index += 1;
      } else {
        controller.close();
      }
    },
  });
}

describe("downloadBlobAudio", () => {
  it("télécharge et concatène les octets d'un blob existant", async () => {
    const part1 = new Uint8Array([1, 2, 3]);
    const part2 = new Uint8Array([4, 5]);
    vi.mocked(get).mockResolvedValue({
      statusCode: 200,
      stream: fakeStream([part1, part2]),
      headers: new Headers(),
      blob: {
        url: "https://example.public.blob.vercel-storage.com/audio/note-1/0",
        downloadUrl: "https://example.public.blob.vercel-storage.com/audio/note-1/0?download=1",
        pathname: "audio/note-1/0",
        contentDisposition: "",
        cacheControl: "",
        uploadedAt: new Date(),
        etag: "etag",
        contentType: "audio/webm",
        size: 5,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forme minimale suffisante pour le test.
    } as any);

    const result = await downloadBlobAudio("https://example.public.blob.vercel-storage.com/audio/note-1/0");

    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4, 5]);
    expect(result.contentType).toBe("audio/webm");
  });

  it("blob introuvable (null) → AUDIO_UNREADABLE, non réessayable", async () => {
    vi.mocked(get).mockResolvedValue(null);

    const promise = downloadBlobAudio("https://example.public.blob.vercel-storage.com/audio/note-1/0");
    await expect(promise).rejects.toBeInstanceOf(TranscriptionError);
    await expect(promise).rejects.toMatchObject({ code: "AUDIO_UNREADABLE", retryable: false });
  });

  it("BlobNotFoundError → AUDIO_UNREADABLE", async () => {
    const error = new Error("not found");
    error.name = "BlobNotFoundError";
    vi.mocked(get).mockRejectedValue(error);

    await expect(
      downloadBlobAudio("https://example.public.blob.vercel-storage.com/audio/note-1/0"),
    ).rejects.toMatchObject({ code: "AUDIO_UNREADABLE", retryable: false });
  });

  it("BlobAccessError (jeton sans accès) → SERVER_MISCONFIGURED, non réessayable", async () => {
    const error = new Error("forbidden");
    error.name = "BlobAccessError";
    vi.mocked(get).mockRejectedValue(error);

    await expect(
      downloadBlobAudio("https://example.public.blob.vercel-storage.com/audio/note-1/0"),
    ).rejects.toMatchObject({ code: "SERVER_MISCONFIGURED", retryable: false });
  });

  it("panne du service Blob → PROVIDER_UNAVAILABLE, réessayable", async () => {
    const error = new Error("service unavailable");
    error.name = "BlobServiceNotAvailable";
    vi.mocked(get).mockRejectedValue(error);

    await expect(
      downloadBlobAudio("https://example.public.blob.vercel-storage.com/audio/note-1/0"),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
  });

  it("erreur réseau inattendue → PROVIDER_UNAVAILABLE par défaut (favorise le réessai)", async () => {
    vi.mocked(get).mockRejectedValue(new TypeError("fetch failed"));

    await expect(
      downloadBlobAudio("https://example.public.blob.vercel-storage.com/audio/note-1/0"),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
  });
});
