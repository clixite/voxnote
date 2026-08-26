// @vitest-environment node
import { describe, expect, it } from "vitest";

import { translateBlobError } from "./blob-errors";

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe("translateBlobError", () => {
  it("BlobNotFoundError → AUDIO_UNREADABLE, non réessayable", () => {
    const result = translateBlobError(namedError("BlobNotFoundError"));
    expect(result).toMatchObject({ code: "AUDIO_UNREADABLE", retryable: false });
  });

  it.each(["BlobAccessError", "BlobStoreNotFoundError"])(
    "%s → SERVER_MISCONFIGURED, non réessayable",
    (name) => {
      const result = translateBlobError(namedError(name));
      expect(result).toMatchObject({ code: "SERVER_MISCONFIGURED", retryable: false });
    },
  );

  it.each(["BlobServiceRateLimited", "BlobServiceNotAvailable"])(
    "%s → PROVIDER_UNAVAILABLE, réessayable",
    (name) => {
      const result = translateBlobError(namedError(name));
      expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    },
  );

  it("erreur sans nom reconnu (réseau, etc.) → PROVIDER_UNAVAILABLE par défaut, réessayable", () => {
    const result = translateBlobError(new TypeError("fetch failed"));
    expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
  });

  it("valeur qui n'est pas une Error → PROVIDER_UNAVAILABLE par défaut, réessayable", () => {
    const result = translateBlobError("erreur non standard");
    expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
  });
});
