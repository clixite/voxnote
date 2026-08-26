// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { getTranscriptionProvider } from "./registry";

describe("getTranscriptionProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["groq", "openai", "gladia"] as const)(
    "instancie le provider « %s » demandé explicitement",
    (id) => {
      expect(getTranscriptionProvider(id).id).toBe(id);
    },
  );

  it("sans argument, résout via TRANSCRIBE_PROVIDER (ici : openai)", () => {
    vi.stubEnv("TRANSCRIBE_PROVIDER", "openai");
    expect(getTranscriptionProvider().id).toBe("openai");
  });

  it("sans argument et sans variable d'environnement, résout sur le défaut « groq »", () => {
    delete process.env.TRANSCRIBE_PROVIDER;
    expect(getTranscriptionProvider().id).toBe("groq");
  });
});
