// @vitest-environment node
import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetThrottleStateForTests } from "@/lib/auth/throttle";

import { POST } from "./route";

const VALID_SECRET = "a".repeat(32);
const PASSPHRASE = "phrase-de-passe-de-test-voxnote";
const HASH = bcrypt.hashSync(PASSPHRASE, 4);

let ipCounter = 0;
/** Une IP différente par test pour ne pas hériter du throttling d'un autre cas. */
function freshIp(): string {
  ipCounter += 1;
  return `10.0.0.${ipCounter}`;
}

function loginRequest(
  body: unknown,
  { ip = freshIp(), rawBody }: { ip?: string; rawBody?: string } = {},
) {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: rawBody ?? JSON.stringify(body),
  });
}

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", VALID_SECRET);
    vi.stubEnv("APP_PASSWORD_HASH", HASH);
    resetThrottleStateForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("bon mot de passe → 204 + cookie vox_session", async () => {
    const response = await POST(loginRequest({ password: PASSPHRASE }));

    expect(response.status).toBe(204);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("vox_session=");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//i);
  });

  it("mauvais mot de passe → 401 INVALID_PASSWORD", async () => {
    const response = await POST(loginRequest({ password: "mauvais" }));

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json).toEqual({
      error: "INVALID_PASSWORD",
      message: "Mot de passe incorrect.",
    });
  });

  it("corps invalide (JSON malformé) → 400 BAD_REQUEST", async () => {
    const response = await POST(
      loginRequest(undefined, { rawBody: "{ ceci n'est pas du json" }),
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toEqual({ error: "BAD_REQUEST", message: "Requête invalide." });
  });

  it("corps invalide (password manquant) → 400 BAD_REQUEST", async () => {
    const response = await POST(loginRequest({}));
    expect(response.status).toBe(400);
  });

  it("corps invalide (password n'est pas une chaîne) → 400 BAD_REQUEST", async () => {
    const response = await POST(loginRequest({ password: 12345 }));
    expect(response.status).toBe(400);
  });

  it("corps invalide (password vide) → 400 BAD_REQUEST", async () => {
    const response = await POST(loginRequest({ password: "" }));
    expect(response.status).toBe(400);
  });

  it("throttling : la 11e tentative échouée depuis la même IP → 429", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i += 1) {
      const response = await POST(loginRequest({ password: "mauvais" }, { ip }));
      expect(response.status).toBe(401);
    }

    const eleventh = await POST(loginRequest({ password: "mauvais" }, { ip }));
    expect(eleventh.status).toBe(429);
    const json = await eleventh.json();
    expect(json.error).toBe("TOO_MANY_ATTEMPTS");

    // Même avec le bon mot de passe, tant que la fenêtre n'est pas passée.
    const stillThrottled = await POST(loginRequest({ password: PASSPHRASE }, { ip }));
    expect(stillThrottled.status).toBe(429);
  });

  it("configuration serveur invalide (AUTH_SECRET absent) → 500 explicite, pas de crash", async () => {
    vi.stubEnv("AUTH_SECRET", "");

    const response = await POST(loginRequest({ password: PASSPHRASE }));
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("SERVER_MISCONFIGURED");
  });
});
