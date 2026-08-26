// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../audio-source", () => ({
  downloadBlobAudio: vi.fn().mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    contentType: "audio/webm",
  }),
}));

import { createOpenAiProvider } from "./openai";

describe("createOpenAiProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("id « openai », appelle l'URL OpenAI avec le modèle whisper-1", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ text: "ok", language: "en" }), { status: 200 }));
    const provider = createOpenAiProvider(fetchImpl);

    expect(provider.id).toBe("openai");
    await provider.transcribe({ audioUrl: "https://x.blob.vercel-storage.com/a", mimeType: "audio/mp4" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
  });
});
