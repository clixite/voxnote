// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthConfigError, getAuthConfig } from "./env";

const VALID_SECRET = "a".repeat(32);
const VALID_HASH = "$2b$10$abcdefghijklmnopqrstuv";

describe("getAuthConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renvoie la config quand AUTH_SECRET et APP_PASSWORD_HASH sont valides", () => {
    vi.stubEnv("AUTH_SECRET", VALID_SECRET);
    vi.stubEnv("APP_PASSWORD_HASH", VALID_HASH);

    expect(getAuthConfig()).toEqual({
      authSecret: VALID_SECRET,
      appPasswordHash: VALID_HASH,
    });
  });

  it("lève une AuthConfigError explicite en français si AUTH_SECRET est absent", () => {
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("APP_PASSWORD_HASH", VALID_HASH);

    expect(() => getAuthConfig()).toThrow(AuthConfigError);
    expect(() => getAuthConfig()).toThrow(/AUTH_SECRET/);
  });

  it("lève une AuthConfigError si AUTH_SECRET fait moins de 32 caractères", () => {
    vi.stubEnv("AUTH_SECRET", "trop-court");
    vi.stubEnv("APP_PASSWORD_HASH", VALID_HASH);

    expect(() => getAuthConfig()).toThrow(AuthConfigError);
    expect(() => getAuthConfig()).toThrow(/32 caractères/);
  });

  it("lève une AuthConfigError explicite en français si APP_PASSWORD_HASH est absent", () => {
    vi.stubEnv("AUTH_SECRET", VALID_SECRET);
    vi.stubEnv("APP_PASSWORD_HASH", "");

    expect(() => getAuthConfig()).toThrow(AuthConfigError);
    expect(() => getAuthConfig()).toThrow(/APP_PASSWORD_HASH/);
  });

  it("ne met pas en cache une configuration invalide puis valide (pas de fallback caché)", () => {
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("APP_PASSWORD_HASH", VALID_HASH);
    expect(() => getAuthConfig()).toThrow(AuthConfigError);

    vi.stubEnv("AUTH_SECRET", VALID_SECRET);
    expect(getAuthConfig()).toEqual({
      authSecret: VALID_SECRET,
      appPasswordHash: VALID_HASH,
    });
  });
});
