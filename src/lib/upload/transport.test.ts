import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "./errors";

const uploadMock = vi.fn();

vi.mock("@vercel/blob/client", () => ({
  upload: (...args: unknown[]) => uploadMock(...args),
}));

// Importé après le mock (hors périmètre ESM hoisting : vi.mock est hissé par
// Vitest avant les imports, donc l'ordre textuel n'a pas d'importance ici,
// mais on importe le module sous test après le mock pour rester lisible).
const { uploadSegmentBlob, transcribeSegmentBlob, blobPathnameFor } = await import(
  "./transport"
);

describe("blobPathnameFor", () => {
  it("suit le préfixe contractuel audio/{noteId}/{seq}", () => {
    expect(blobPathnameFor("note-1", 3)).toBe("audio/note-1/3");
  });
});

describe("uploadSegmentBlob", () => {
  afterEach(() => {
    uploadMock.mockReset();
  });

  it("téléverse via @vercel/blob/client avec le chemin, l'accès privé et le clientPayload contractuels", async () => {
    uploadMock.mockResolvedValue({ url: "https://blob.example/audio/note-1/0" });

    const blob = new Blob(["contenu-audio"], { type: "audio/webm" });
    const url = await uploadSegmentBlob({
      noteId: "note-1",
      seq: 0,
      blob,
      mimeType: "audio/webm",
    });

    expect(url).toBe("https://blob.example/audio/note-1/0");
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [pathname, body, options] = uploadMock.mock.calls[0] as [
      string,
      Blob,
      Record<string, unknown>,
    ];
    expect(pathname).toBe("audio/note-1/0");
    expect(body).toBe(blob);
    expect(options.access).toBe("private");
    expect(options.handleUploadUrl).toBe("/api/blob/upload-token");
    expect(JSON.parse(options.clientPayload as string)).toEqual({
      noteId: "note-1",
      seq: 0,
      mimeType: "audio/webm",
      sizeBytes: blob.size,
    });
  });

  it("laisse remonter tel quel un échec de upload() (classifié plus tard par errors.ts)", async () => {
    const boom = new TypeError("Failed to fetch");
    uploadMock.mockRejectedValue(boom);

    await expect(
      uploadSegmentBlob({
        noteId: "note-1",
        seq: 0,
        blob: new Blob(["x"]),
        mimeType: "audio/webm",
      }),
    ).rejects.toBe(boom);
  });
});

describe("transcribeSegmentBlob", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("poste noteId/seq/blobUrl/mimeType/lang, jamais de binaire", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          noteId: "note-1",
          seq: 0,
          text: "bonjour",
          language: "fr",
          provider: "groq",
          durationMs: 1200,
        }),
        { status: 200 },
      ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await transcribeSegmentBlob({
      noteId: "note-1",
      seq: 0,
      blobUrl: "https://blob.example/audio/note-1/0",
      mimeType: "audio/webm",
      lang: "auto",
    });

    expect(result.text).toBe("bonjour");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/transcribe");
    const parsedBody = JSON.parse(init.body as string);
    expect(parsedBody).toEqual({
      noteId: "note-1",
      seq: 0,
      blobUrl: "https://blob.example/audio/note-1/0",
      mimeType: "audio/webm",
      lang: "auto",
    });
  });

  it("rejette avec ApiRequestError quand le corps d'erreur est bien formé", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "PROVIDER_QUOTA",
          message: "Le quota de transcription est épuisé pour aujourd'hui.",
          retryable: false,
        }),
        { status: 429 },
      ),
    ) as unknown as typeof fetch;

    const promise = transcribeSegmentBlob({
      noteId: "note-1",
      seq: 0,
      blobUrl: "https://blob.example/audio/note-1/0",
      mimeType: "audio/webm",
      lang: "auto",
    });

    await expect(promise).rejects.toBeInstanceOf(ApiRequestError);
    await promise.catch((err: ApiRequestError) => {
      expect(err.retryable).toBe(false);
      expect(err.message).toBe("Le quota de transcription est épuisé pour aujourd'hui.");
    });
  });

  it("rejette avec une erreur générique quand le corps d'erreur n'est pas exploitable (route pas encore déployée)", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("erreur serveur", { status: 500 })) as unknown as typeof fetch;

    await expect(
      transcribeSegmentBlob({
        noteId: "note-1",
        seq: 0,
        blobUrl: "https://blob.example/audio/note-1/0",
        mimeType: "audio/webm",
        lang: "auto",
      }),
    ).rejects.not.toBeInstanceOf(ApiRequestError);
  });
});
