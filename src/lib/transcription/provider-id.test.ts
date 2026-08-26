// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { TranscriptionError } from "./errors";
import { resolveProviderId } from "./provider-id";

describe("resolveProviderId", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renvoie « groq » par défaut quand TRANSCRIBE_PROVIDER est absent", () => {
    delete process.env.TRANSCRIBE_PROVIDER;
    expect(resolveProviderId()).toBe("groq");
  });

  it("renvoie « groq » quand TRANSCRIBE_PROVIDER est une chaîne vide", () => {
    vi.stubEnv("TRANSCRIBE_PROVIDER", "");
    expect(resolveProviderId()).toBe("groq");
  });

  it.each(["groq", "openai", "gladia"] as const)(
    "accepte la valeur valide « %s »",
    (value) => {
      vi.stubEnv("TRANSCRIBE_PROVIDER", value);
      expect(resolveProviderId()).toBe(value);
    },
  );

  it("échoue explicitement sur une valeur inconnue, sans repli silencieux sur le défaut", () => {
    vi.stubEnv("TRANSCRIBE_PROVIDER", "azure");

    expect(() => resolveProviderId()).toThrow(TranscriptionError);
    try {
      resolveProviderId();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TranscriptionError);
      const transcriptionError = error as TranscriptionError;
      expect(transcriptionError.code).toBe("SERVER_MISCONFIGURED");
      expect(transcriptionError.retryable).toBe(false);
      // Liste les valeurs valides pour que l'exploitant sache quoi corriger.
      expect(transcriptionError.detail).toContain("groq");
      expect(transcriptionError.detail).toContain("openai");
      expect(transcriptionError.detail).toContain("gladia");
      expect(transcriptionError.detail).toContain("azure");
    }
  });
});
