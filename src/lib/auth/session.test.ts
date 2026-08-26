// @vitest-environment node
import { SignJWT } from "jose/jwt/sign";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildClearedSessionCookie,
  buildSessionCookie,
  COOKIE_NAME,
  createSessionToken,
  verifySessionToken,
} from "./session";

const VALID_SECRET = "a".repeat(32);
const HASH_V1 = "$2b$10$hash-version-un";
const HASH_V2 = "$2b$10$hash-version-deux";

describe("createSessionToken / verifySessionToken", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", VALID_SECRET);
    vi.stubEnv("APP_PASSWORD_HASH", HASH_V1);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("un token fraîchement émis est valide", async () => {
    const token = await createSessionToken();
    await expect(verifySessionToken(token)).resolves.toBe(true);
  });

  it("renvoie false pour un token absent", async () => {
    await expect(verifySessionToken(undefined)).resolves.toBe(false);
    await expect(verifySessionToken(null)).resolves.toBe(false);
    await expect(verifySessionToken("")).resolves.toBe(false);
  });

  it("renvoie false pour un token quelconque (pas un JWT)", async () => {
    await expect(verifySessionToken("pas-un-jwt")).resolves.toBe(false);
  });

  it("rejette un cookie signé avec un mauvais secret", async () => {
    const wrongSecret = new TextEncoder().encode("b".repeat(32));
    const forged = await new SignJWT({ pv: "0000000000000000" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(wrongSecret);

    await expect(verifySessionToken(forged)).resolves.toBe(false);
  });

  it("rejette un token expiré", async () => {
    const secretKey = new TextEncoder().encode(VALID_SECRET);
    const expired = await new SignJWT({ pv: "0000000000000000" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secretKey);

    await expect(verifySessionToken(expired)).resolves.toBe(false);
  });

  it("rejette un cookie valide dont le `pv` est obsolète (changement de mot de passe)", async () => {
    const token = await createSessionToken();
    await expect(verifySessionToken(token)).resolves.toBe(true);

    // Simule un changement d'APP_PASSWORD_HASH (redéploiement) : la session
    // émise avec l'ancien hash doit devenir invalide.
    vi.stubEnv("APP_PASSWORD_HASH", HASH_V2);
    await expect(verifySessionToken(token)).resolves.toBe(false);
  });

  it("rejette un token sans claim `exp`", async () => {
    const secretKey = new TextEncoder().encode(VALID_SECRET);
    const noExp = await new SignJWT({ pv: "0000000000000000" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .sign(secretKey);

    await expect(verifySessionToken(noExp)).resolves.toBe(false);
  });

  it("rejette un token sans claim `iat` (requis par maxTokenAge)", async () => {
    const secretKey = new TextEncoder().encode(VALID_SECRET);
    const noIat = await new SignJWT({ pv: "0000000000000000" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("30d")
      .sign(secretKey);

    await expect(verifySessionToken(noIat)).resolves.toBe(false);
  });
});

describe("cookies de session", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("buildSessionCookie pose le bon nom, maxAge et attributs de sécurité", () => {
    const cookie = buildSessionCookie("un-token");
    expect(cookie).toMatchObject({
      name: COOKIE_NAME,
      value: "un-token",
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  });

  it("buildClearedSessionCookie vide la valeur et met maxAge à 0", () => {
    const cookie = buildClearedSessionCookie();
    expect(cookie).toMatchObject({
      name: COOKIE_NAME,
      value: "",
      maxAge: 0,
    });
  });

  it("secure=false hors plateforme Vercel (local, CI, e2e sur 127.0.0.1)", () => {
    vi.stubEnv("VERCEL", "");
    expect(buildSessionCookie("un-token").secure).toBe(false);
    expect(buildClearedSessionCookie().secure).toBe(false);
  });

  it("secure=true quand VERCEL=1 (déploiement réel, servi en HTTPS)", () => {
    vi.stubEnv("VERCEL", "1");
    expect(buildSessionCookie("un-token").secure).toBe(true);
    expect(buildClearedSessionCookie().secure).toBe(true);
  });
});
