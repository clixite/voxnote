// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../audio-source", () => ({
  downloadBlobAudio: vi.fn().mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    contentType: "audio/webm",
  }),
}));

import { createGroqProvider } from "./groq";

describe("createGroqProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("id « groq », appelle l'URL Groq avec le modèle whisper-large-v3-turbo", async () => {
    vi.stubEnv("GROQ_API_KEY", "sk-test");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ text: "ok", language: "fr" }), { status: 200 }));
    const provider = createGroqProvider(fetchImpl);

    expect(provider.id).toBe("groq");
    await provider.transcribe({ audioUrl: "https://x.blob.vercel-storage.com/a", mimeType: "audio/webm" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
  });
});
