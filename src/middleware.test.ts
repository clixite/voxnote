// @vitest-environment node
import { SignJWT } from "jose/jwt/sign";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionToken } from "@/lib/auth/session";

import { config, middleware } from "./middleware";

const VALID_SECRET = "a".repeat(32);
const HASH_V1 = "$2b$10$hash-version-un";
const HASH_V2 = "$2b$10$hash-version-deux";

function requestTo(pathOrUrl: string, cookieValue?: string): NextRequest {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `http://localhost${pathOrUrl}`;
  const headers = new Headers();
  if (cookieValue) headers.set("cookie", `vox_session=${cookieValue}`);
  return new NextRequest(url, { headers });
}

describe("middleware (protection des routes)", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", VALID_SECRET);
    vi.stubEnv("APP_PASSWORD_HASH", HASH_V1);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("page protégée sans cookie → 307 vers /login avec ?from=<pathname>", async () => {
    const response = await middleware(requestTo("/notes/42"));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "", "http://localhost");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("from")).toBe("/notes/42");
  });

  it("route /api/* protégée sans cookie → 401 UNAUTHENTICATED", async () => {
    const response = await middleware(requestTo("/api/notes"));

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json).toEqual({
      error: "UNAUTHENTICATED",
      message: "Session expirée. Reconnecte-toi.",
    });
  });

  it("page protégée avec un cookie de session valide → laisse passer", async () => {
    const token = await createSessionToken();
    const response = await middleware(requestTo("/", token));

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("route /api/* avec un cookie de session valide → laisse passer", async () => {
    const token = await createSessionToken();
    const response = await middleware(requestTo("/api/notes", token));

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("cookie signé avec un mauvais secret → rejeté (redirection /login)", async () => {
    const wrongSecret = new TextEncoder().encode("b".repeat(32));
    const forged = await new SignJWT({ pv: "0000000000000000" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(wrongSecret);

    const response = await middleware(requestTo("/", forged));
    expect(response.status).toBe(307);
  });

  it("cookie valide mais pv obsolète (APP_PASSWORD_HASH a changé) → rejeté", async () => {
    const token = await createSessionToken();

    vi.stubEnv("APP_PASSWORD_HASH", HASH_V2);
    const response = await middleware(requestTo("/", token));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "", "http://localhost");
    expect(location.pathname).toBe("/login");
  });

  it("cookie valide mais pv obsolète sur une route /api/* → 401", async () => {
    const token = await createSessionToken();

    vi.stubEnv("APP_PASSWORD_HASH", HASH_V2);
    const response = await middleware(requestTo("/api/notes", token));

    expect(response.status).toBe(401);
  });

  it("from=//evil.com (pathname forgé en //evil.com) → jamais propagé tel quel : pas de redirection externe", async () => {
    // `new URL("http://localhost//evil.com").pathname === "//evil.com"` :
    // c'est le vecteur d'open-redirect visé, pas un query param `from`.
    const response = await middleware(requestTo("http://localhost//evil.com"));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "", "http://localhost");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("from")).toBe("/");
    expect(location.searchParams.get("from")).not.toContain("evil.com");
  });

  it("configuration serveur invalide → 500 explicite sur une page, pas de boucle de redirection", async () => {
    vi.stubEnv("AUTH_SECRET", "");

    const response = await middleware(requestTo("/"));
    expect(response.status).toBe(500);
  });

  it("configuration serveur invalide → 500 JSON explicite sur une route /api/*", async () => {
    vi.stubEnv("AUTH_SECRET", "");

    const response = await middleware(requestTo("/api/notes"));
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("SERVER_MISCONFIGURED");
  });
});

describe("middleware — matcher (exclusion des routes publiques)", () => {
  const pattern = config.matcher[0];
  if (!pattern) throw new Error("config.matcher est vide");
  // Next.js compile ce motif comme un match complet du pathname (d'où
  // l'obligation qu'il commence par "/", vérifiée par `next build`) ; on
  // reproduit cet ancrage ici, sans quoi un `RegExp.test()` nu retenterait
  // un match plus loin dans la chaîne et fausserait le test (ex. accepterait
  // à tort "/api/auth/login" en repartant de "/auth/login").
  const regex = new RegExp(`^${pattern}$`);

  it.each([
    "/login",
    "/confidentialite",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/cron/purge",
    "/manifest.webmanifest",
    "/sw.js",
    "/icon.png",
    "/apple-icon.png",
    "/icons/icon-192.png",
    "/_next/static/chunk.js",
    "/favicon.ico",
  ])("%s est exclu de la protection", (path) => {
    expect(regex.test(path)).toBe(false);
  });

  it.each([
    "/",
    "/notes/42",
    "/api/notes",
    "/api/blob/upload-token",
    "/loginfoo",
    "/confidentialite-fake",
    "/api/cron/autre-chose",
    "/api/cron/purge/",
    "/api/cron/purgefoo",
    "/api/cron",
  ])("%s reste protégé", (path) => {
    expect(regex.test(path)).toBe(true);
  });
});
