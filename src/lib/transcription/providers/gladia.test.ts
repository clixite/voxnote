// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../audio-source", () => ({
  downloadBlobAudio: vi.fn().mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    contentType: "audio/webm",
  }),
}));

import { createGladiaProvider } from "./gladia";

const AUDIO_URL = "https://x.blob.vercel-storage.com/audio/note-1/0";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function noopSleep() {
  return vi.fn().mockResolvedValue(undefined);
}

describe("createGladiaProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("succès : upload → init → poll (queued puis done)", async () => {
    vi.stubEnv("GLADIA_API_KEY", "gk-test");
    const fetchImpl = vi
      .fn()
      // 1. upload
      .mockResolvedValueOnce(jsonResponse(200, { audio_url: "https://api.gladia.io/files/abc" }))
      // 2. init
      .mockResolvedValueOnce(
        jsonResponse(201, {
          id: "job-1",
          result_url: "https://api.gladia.io/v2/pre-recorded/job-1",
        }),
      )
      // 3. poll #1 : encore en cours
      .mockResolvedValueOnce(jsonResponse(200, { status: "processing" }))
      // 4. poll #2 : terminé
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: "done",
          result: {
            transcription: {
              full_transcript: "bonjour tout le monde",
              languages: ["fr"],
            },
          },
        }),
      );

    const provider = createGladiaProvider({ fetchImpl, sleep: noopSleep() });
    const result = await provider.transcribe({ audioUrl: AUDIO_URL, mimeType: "audio/webm" });

    expect(result.text).toBe("bonjour tout le monde");
    expect(result.language).toBe("fr");
    expect(result.provider).toBe("gladia");
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    // Header d'authentification Gladia sur chaque appel.
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>)["x-gladia-key"]).toBe("gk-test");
    }

    // La langue forcée est bien transmise dans language_config à l'init.
    const [, initInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(initInit.body as string)).toMatchObject({
      audio_url: "https://api.gladia.io/files/abc",
    });
  });

  it("langue forcée : transmise dans language_config.languages à l'init", async () => {
    vi.stubEnv("GLADIA_API_KEY", "gk-test");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { audio_url: "https://api.gladia.io/files/abc" }))
      .mockResolvedValueOnce(jsonResponse(201, { id: "job-1", result_url: "https://api.gladia.io/v2/pre-recorded/job-1" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: "done",
          result: { transcription: { full_transcript: "hallo", languages: ["nl"] } },
        }),
      );

    const provider = createGladiaProvider({ fetchImpl, sleep: noopSleep() });
    await provider.transcribe({ audioUrl: AUDIO_URL, mimeType: "audio/webm", language: "nl" });

    const [, initInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const initBody = JSON.parse(initInit.body as string) as { language_config?: { languages: string[] } };
    expect(initBody.language_config).toEqual({ languages: ["nl"] });
  });

  it("clé API absente → SERVER_MISCONFIGURED, non réessayable, sans appel réseau", async () => {
    delete process.env.GLADIA_API_KEY;
    const fetchImpl = vi.fn();
    const provider = createGladiaProvider({ fetchImpl, sleep: noopSleep() });

    await expect(
      provider.transcribe({ audioUrl: AUDIO_URL, mimeType: "audio/webm" }),
    ).rejects.toMatchObject({ code: "SERVER_MISCONFIGURED", retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("401 à l'upload → SERVER_MISCONFIGURED, non réessayable", async () => {
    vi.stubEnv("GLADIA_API_KEY", "gk-bad");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { message: "invalid API key" }));
    const provider = createGladiaProvider({ fetchImpl, sleep: noopSleep() });

    await expect(
      provider.transcribe({ audioUrl: AUDIO_URL, mimeType: "audio/webm" }),
    ).rejects.toMatchObject({ code: "SERVER_MISCONFIGURED", retryable: false });
  });

  it("le job se termine en erreur (status: error) → AUDIO_UNREADABLE, non réessayable", async () => {
    vi.stubEnv("GLADIA_API_KEY", "gk-test");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { audio_url: "https://api.gladia.io/files/abc" }))
      .mockResolvedValueOnce(jsonResponse(201, { id: "job-1", result_url: "https://api.gladia.io/v2/pre-recorded/job-1" }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "error", error_code: 422 }));

    const provider = createGladiaProvider({ fetchImpl, sleep: noopSleep() });

    await expect(
      provider.transcribe({ audioUrl: AUDIO_URL, mimeType: "audio/webm" }),
    ).rejects.toMatchObject({ code: "AUDIO_UNREADABLE", retryable: false });
  });

  it("dépassement du budget de sondage → PROVIDER_UNAVAILABLE, réessayable", async () => {
    vi.stubEnv("GLADIA_API_KEY", "gk-test");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { audio_url: "https://api.gladia.io/files/abc" }))
      .mockResolvedValueOnce(jsonResponse(201, { id: "job-1", result_url: "https://api.gladia.io/v2/pre-recorded/job-1" }))
      // Toujours "processing", jamais "done" : timeout. Une nouvelle Response
      // à chaque appel — un corps de réponse ne se lit qu'une fois.
      .mockImplementation(() => Promise.resolve(jsonResponse(200, { status: "processing" })));

    const provider = createGladiaProvider({ fetchImpl, sleep: noopSleep(), maxPollAttempts: 3 });

    await expect(
      provider.transcribe({ audioUrl: AUDIO_URL, mimeType: "audio/webm" }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
  });

  it("échec réseau → PROVIDER_UNAVAILABLE, réessayable", async () => {
    vi.stubEnv("GLADIA_API_KEY", "gk-test");
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const provider = createGladiaProvider({ fetchImpl, sleep: noopSleep() });

    await expect(
      provider.transcribe({ audioUrl: AUDIO_URL, mimeType: "audio/webm" }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
  });
});
