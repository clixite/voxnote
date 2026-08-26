// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { BlobConfigError, getBlobConfig } from "./env";

const VALID_TOKEN = "vercel_blob_rw_teststoreid_secretsecret";

describe("getBlobConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renvoie la config quand BLOB_READ_WRITE_TOKEN est présent", () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", VALID_TOKEN);

    expect(getBlobConfig()).toEqual({ token: VALID_TOKEN });
  });

  it("lève une BlobConfigError explicite en français si BLOB_READ_WRITE_TOKEN est absent", () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");

    expect(() => getBlobConfig()).toThrow(BlobConfigError);
    expect(() => getBlobConfig()).toThrow(/BLOB_READ_WRITE_TOKEN/);
  });

  it("ne met pas en cache une configuration invalide puis valide", () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    expect(() => getBlobConfig()).toThrow(BlobConfigError);

    vi.stubEnv("BLOB_READ_WRITE_TOKEN", VALID_TOKEN);
    expect(getBlobConfig()).toEqual({ token: VALID_TOKEN });
  });
});
