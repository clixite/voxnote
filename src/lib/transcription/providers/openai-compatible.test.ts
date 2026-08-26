// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../audio-source", () => ({
  downloadBlobAudio: vi.fn(),
}));

import { downloadBlobAudio } from "../audio-source";
import { createOpenAiCompatibleProvider } from "./openai-compatible";

const AUDIO_URL = "https://example.public.blob.vercel-storage.com/audio/note-1/0";
const AUDIO_BYTES = new Uint8Array([1, 2, 3]);

function stubDownload() {
  vi.mocked(downloadBlobAudio).mockResolvedValue({
    bytes: AUDIO_BYTES,
    contentType: "audio/webm",
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createOpenAiCompatibleProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("succès : envoie le bon modèle et renvoie texte/langue/durée", async () => {
    stubDownload();
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { text: "bonjour le monde", language: "fr", duration: 12.5 }),
    );
    const provider = createOpenAiCompatibleProvider({
      id: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "whisper-large-v3-turbo",
      apiKeyEnvVar: "GROQ_API_KEY",
      fetchImpl,
    });
    vi.stubEnv("GROQ_API_KEY", "sk-test");

    const result = await provider.transcribe({
      audioUrl: AUDIO_URL,
      mimeType: "audio/webm",
      language: "fr",
    });

    expect(result).toEqual({
      text: "bonjour le monde",
      language: "fr",
      durationMs: 12500,
      provider: "groq",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("language")).toBe("fr");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("langue absente (auto) : n'envoie pas de champ language, retombe sur celle du provider", async () => {
    stubDownload();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { text: "hi", language: "en" }));
    const provider = createOpenAiCompatibleProvider({
      id: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "whisper-large-v3-turbo",
      apiKeyEnvVar: "GROQ_API_KEY",
      fetchImpl,
    });
    vi.stubEnv("GROQ_API_KEY", "sk-test");

    await provider.transcribe({ audioUrl: AUDIO_URL, mimeType: "audio/webm" });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const form = init.body as FormData;
    expect(form.has("language")).toBe(false);
  });

  it("clé API absente → SERVER_MISCONFIGURED, non réessayable, sans appel réseau", async () => {
    stubDownload();
    const fetchImpl = vi.fn();
    const provider = createOpenAiCompatibleProvider({
      id: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "whisper-large-v3-turbo",
      apiKeyEnvVar: "GROQ_API_KEY",
      fetchImpl,
    });
    vi.stubEnv("GROQ_API_KEY", "");
    delete process.env.GROQ_API_KEY;

    await expect(
      provider.transcribe({ audioUrl: AUDIO_URL, mimeType: "audio/webm" }),
    ).rejects.toMatchObject({ code: "SERVER_MISCONFIGURED", retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("401 (clé refusée) → SERVER_MISCONFIGURED, non réessayable", async () => {
    stubDownload();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { error: { message: "Invalid API Key", type: "invalid_request_error" } }));
    const provider = createOpenAiCompatibleProvider({
      id: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "whisper-1",
      apiKeyEnvVar: "OPENAI_API_KEY",
      fetchImpl,
    });
    vi.stubEnv("OPENAI_API_KEY", "sk-bad");

    await expect(
      provider.transcribe({ audioUrl: AUDIO_URL, mimeType: "audio/webm" }),
    ).rejects.toMatchObject({ code: "SERVER_MISCONFIGURED", retryable: false });
  });

  it("429 rate_limit_exceeded (débit) → PROVIDER_QUOTA, réessayable", async () => {
    stubDownload();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(429, { error: { message: "Rate limit reached", type: "rate_limit_exceeded" } }),
      );
    const provider = createOpenAiCompatibleProvider({
      id: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "whisper-large-v3-turbo",
      apiKeyEnvVar: "GROQ_API_KEY",
      fetchImpl,
    });
    vi.stubEnv("GROQ_API_KEY", "sk-test");

    await expect(
      provider.transcribe({ audioUrl: AUDIO_URL, mimeType: "audio/webm" }),
    ).rejects.toMatchObject({ code: "PROVIDER_QUOTA", retryable: true });
  });

  it("429 insufficient_quota (quota épuisé) → PROVIDER_QUOTA, NON réessayable", async () => {
    stubDownload();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(429, { error: { message: "You exceeded your quota", type: "insufficient_quota" } }),
      );
    const provider = createOpenAiCompatibleProvider({
      id: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "whisper-1",
      apiKeyEnvVar: "OPENAI_API_KEY",
      fetchImpl,
    });
    vi.stubEnv("OPENAI_API_KEY", "sk-test");

    await expect(
      provider.transcribe({ audioUrl: AUDIO_URL, mimeType: "audio/webm" }),
    ).rejects.toMatchObject({ code: "PROVIDER_QUOTA", retryable: false });
  });

  it("503 → PROVIDER_UNAVAILABLE, réessayable", async () => {
    stubDownload();
    const fetchImpl = vi.fn().mockResolvedValue(new Response("service unavailable", { status: 503 }));
    const provider = createOpenAiCompatibleProvider({
      id: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "whisper-large-v3-turbo",
      apiKeyEnvVar: "GROQ_API_KEY",
      fetchImpl,
    });
    vi.stubEnv("GROQ_API_KEY", "sk-test");

    await expect(
      provider.transcribe({ audioUrl: AUDIO_URL, mimeType: "audio/webm" }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
  });

  it("400 (fichier rejeté) → AUDIO_UNREADABLE, non réessayable", async () => {
    stubDownload();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: { message: "Invalid file format", type: "invalid_request_error" } }));
    const provider = createOpenAiCompatibleProvider({
      id: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "whisper-large-v3-turbo",
      apiKeyEnvVar: "GROQ_API_KEY",
      fetchImpl,
    });
    vi.stubEnv("GROQ_API_KEY", "sk-test");

    await expect(
      provider.transcribe({ audioUrl: AUDIO_URL, mimeType: "audio/webm" }),
    ).rejects.toMatchObject({ code: "AUDIO_UNREADABLE", retryable: false });
  });

  it("échec réseau (fetch qui lève) → PROVIDER_UNAVAILABLE, réessayable", async () => {
    stubDownload();
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const provider = createOpenAiCompatibleProvider({
      id: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "whisper-large-v3-turbo",
      apiKeyEnvVar: "GROQ_API_KEY",
      fetchImpl,
    });
    vi.stubEnv("GROQ_API_KEY", "sk-test");

    await expect(
      provider.transcribe({ audioUrl: AUDIO_URL, mimeType: "audio/webm" }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
  });
});
