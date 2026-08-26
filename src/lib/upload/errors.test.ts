import { describe, expect, it } from "vitest";

import {
  ambiguousExhaustedMessage,
  ApiRequestError,
  classifyUploadError,
} from "./errors";

describe("classifyUploadError", () => {
  it("suit `retryable: true` d'une ApiRequestError", () => {
    const err = new ApiRequestError({
      error: "PROVIDER_UNAVAILABLE",
      message: "Le service de transcription est momentanément indisponible.",
      retryable: true,
    });
    const result = classifyUploadError(err);
    expect(result.tier).toBe("retryable");
    expect(result.message).toBe(
      "Le service de transcription est momentanément indisponible.",
    );
  });

  it("suit `retryable: false` d'une ApiRequestError sans jamais deviner", () => {
    const err = new ApiRequestError({
      error: "BAD_REQUEST",
      message: "Ce fichier audio est illisible.",
      retryable: false,
    });
    const result = classifyUploadError(err);
    expect(result.tier).toBe("non-retryable");
    expect(result.message).toBe("Ce fichier audio est illisible.");
  });

  it("reconnaît une coupure réseau (TypeError de fetch) comme retryable", () => {
    const result = classifyUploadError(new TypeError("Failed to fetch"));
    expect(result.tier).toBe("retryable");
    expect(result.message).toMatch(/connexion/i);
  });

  it("classe toute autre erreur comme ambiguë plutôt que de deviner", () => {
    const result = classifyUploadError(new Error("Failed to retrieve the client token"));
    expect(result.tier).toBe("ambiguous");
  });

  it("classe une valeur rejetée non-Error comme ambiguë", () => {
    const result = classifyUploadError("boom");
    expect(result.tier).toBe("ambiguous");
  });

  it("message d'épuisement toujours en français et rassurant", () => {
    const message = ambiguousExhaustedMessage();
    expect(message).toMatch(/sécurité/);
    expect(message).toMatch(/Réessayer/);
  });
});
