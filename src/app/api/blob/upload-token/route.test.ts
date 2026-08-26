// @vitest-environment node
import { getPayloadFromClientToken } from "@vercel/blob/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetRateLimitStateForTests } from "@/lib/blob/rateLimit";
import { MAX_SEGMENT_BYTES } from "@/types/api";

import { POST } from "./route";

const VALID_TOKEN = "vercel_blob_rw_teststoreid_secretsecret";
const NOTE_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

let ipCounter = 0;
/** Une IP différente par test pour ne pas hériter du rate limiting d'un autre cas. */
function freshIp(): string {
  ipCounter += 1;
  return `10.1.0.${ipCounter}`;
}

function generateTokenRequest(
  payload: {
    pathname: string;
    clientPayload: string | null;
    multipart?: boolean;
  },
  { ip = freshIp(), rawBody }: { ip?: string; rawBody?: string } = {},
) {
  return new Request("http://localhost/api/blob/upload-token", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body:
      rawBody ??
      JSON.stringify({
        type: "blob.generate-client-token",
        payload: { multipart: false, ...payload },
      }),
  });
}

function validClientPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    noteId: NOTE_ID,
    seq: 0,
    mimeType: "audio/webm",
    sizeBytes: 1024,
    ...overrides,
  });
}

describe("POST /api/blob/upload-token", () => {
  beforeEach(() => {
    resetRateLimitStateForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("payload valide + chemin conforme → jeton émis", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", VALID_TOKEN);

    const response = await POST(
      generateTokenRequest({
        pathname: `audio/${NOTE_ID}/0`,
        clientPayload: validClientPayload(),
      }),
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.type).toBe("blob.generate-client-token");
    expect(typeof json.clientToken).toBe("string");
  });

  it("jeton valable environ 5 minutes, pas l'heure par défaut du SDK (revue C3)", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", VALID_TOKEN);
    const before = Date.now();

    const response = await POST(
      generateTokenRequest({
        pathname: `audio/${NOTE_ID}/0`,
        clientPayload: validClientPayload(),
      }),
    );
    const after = Date.now();

    const json = await response.json();
    const decoded = getPayloadFromClientToken(json.clientToken as string);

    // Fenêtre acceptée : [before + 5 min, after + 5 min]. Une valeur proche
    // de l'heure par défaut du SDK (`now + 3600s`) ferait échouer largement
    // cette assertion — c'est précisément ce qu'on veut détecter.
    expect(decoded.validUntil).toBeGreaterThanOrEqual(before + 5 * 60 * 1000);
    expect(decoded.validUntil).toBeLessThanOrEqual(after + 5 * 60 * 1000);
  });

  it("corps JSON malformé → 400 BAD_REQUEST", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", VALID_TOKEN);

    const response = await POST(
      generateTokenRequest(
        { pathname: "x", clientPayload: null },
        { rawBody: "{ ceci n'est pas du json" },
      ),
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toEqual({
      error: "BAD_REQUEST",
      message: "Requête invalide.",
      retryable: false,
    });
  });

  it("clientPayload absent → 400 BAD_REQUEST", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", VALID_TOKEN);

    const response = await POST(
      generateTokenRequest({ pathname: `audio/${NOTE_ID}/0`, clientPayload: null }),
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("BAD_REQUEST");
    expect(json.retryable).toBe(false);
  });

  it("noteId malformé → 400 BAD_REQUEST avec message français", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", VALID_TOKEN);

    const response = await POST(
      generateTokenRequest({
        pathname: "audio/pas-un-uuid/0",
        clientPayload: validClientPayload({ noteId: "pas-un-uuid" }),
      }),
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("BAD_REQUEST");
    expect(json.message).toMatch(/note/i);
  });

  it("mimeType hors liste blanche → 400 BAD_REQUEST", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", VALID_TOKEN);

    const response = await POST(
      generateTokenRequest({
        pathname: `audio/${NOTE_ID}/0`,
        clientPayload: validClientPayload({ mimeType: "video/mp4" }),
      }),
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.message).toMatch(/format audio/i);
  });

  it("taille au-dessus du plafond → 400 BAD_REQUEST", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", VALID_TOKEN);

    const response = await POST(
      generateTokenRequest({
        pathname: `audio/${NOTE_ID}/0`,
        clientPayload: validClientPayload({
          sizeBytes: MAX_SEGMENT_BYTES + 1,
        }),
      }),
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.message).toMatch(/volumineux/i);
  });

  it("pathname demandé ne correspond pas à audio/{noteId}/{seq} → 400 BAD_REQUEST", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", VALID_TOKEN);

    const response = await POST(
      generateTokenRequest({
        pathname: "autre-chemin/0",
        clientPayload: validClientPayload(),
      }),
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.message).toMatch(/chemin/i);
  });

  it("BLOB_READ_WRITE_TOKEN absent → 500 SERVER_MISCONFIGURED explicite en français", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");

    const response = await POST(
      generateTokenRequest({
        pathname: `audio/${NOTE_ID}/0`,
        clientPayload: validClientPayload(),
      }),
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("SERVER_MISCONFIGURED");
    expect(json.message).toMatch(/BLOB_READ_WRITE_TOKEN/);
  });

  it("rate limiting : dépasse le plafond de requêtes depuis la même IP → 429", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", VALID_TOKEN);
    const ip = freshIp();

    for (let i = 0; i < 60; i += 1) {
      const response = await POST(
        generateTokenRequest(
          { pathname: `audio/${NOTE_ID}/0`, clientPayload: validClientPayload() },
          { ip },
        ),
      );
      expect(response.status).toBe(200);
    }

    const overLimit = await POST(
      generateTokenRequest(
        { pathname: `audio/${NOTE_ID}/0`, clientPayload: validClientPayload() },
        { ip },
      ),
    );
    expect(overLimit.status).toBe(429);
    const json = await overLimit.json();
    expect(json.error).toBe("RATE_LIMITED");
    expect(json.retryable).toBe(true);
  });
});
