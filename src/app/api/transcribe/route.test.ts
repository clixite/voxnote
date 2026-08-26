// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/blob/store", () => ({
  headBlob: vi.fn(),
  getBlobStream: vi.fn(),
}));

import { getBlobStream, headBlob } from "@/lib/blob/store";

import { resetRateLimitStateForTests } from "@/lib/transcription/rate-limit";

import { POST } from "./route";

// `noteId` doit être un UUID (revue S4 : même contrat que `/api/blob/upload-token`,
// voir `@/lib/blob/validation#isValidNoteId`).
const NOTE_ID = "550e8400-e29b-41d4-a716-446655440000";
const SEQ = 0;
const BLOB_URL = `https://example.public.blob.vercel-storage.com/audio/${NOTE_ID}/0`;
const MIME_TYPE = "audio/webm";

let ipCounter = 0;
/** Une IP différente par test pour ne pas hériter du rate limiting d'un autre cas. */
function freshIp(): string {
  ipCounter += 1;
  return `10.9.0.${ipCounter}`;
}

function transcribeRequest(
  body: unknown,
  { ip = freshIp(), rawBody }: { ip?: string; rawBody?: string } = {},
) {
  return new Request("http://localhost/api/transcribe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: rawBody ?? JSON.stringify(body),
  });
}

function validBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    noteId: NOTE_ID,
    seq: SEQ,
    blobUrl: BLOB_URL,
    mimeType: MIME_TYPE,
    lang: "auto",
    ...overrides,
  };
}

function namedError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** Fait passer la garde anti-SSRF : le blob appartient à notre store et au bon segment. */
function stubOwnedBlob(pathname = `audio/${NOTE_ID}/${SEQ}`) {
  vi.mocked(headBlob).mockResolvedValue({
    url: BLOB_URL,
    downloadUrl: BLOB_URL,
    pathname,
    size: 1234,
    uploadedAt: new Date(),
    contentType: MIME_TYPE,
    contentDisposition: "",
    cacheControl: "",
    etag: "etag",
  });
}

function fakeAudioStream(): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        sent = true;
      } else {
        controller.close();
      }
    },
  });
}

/** Un nouveau flux à chaque appel : un réessai retélécharge le segment. */
function stubAudioDownload() {
  vi.mocked(getBlobStream).mockImplementation(async () => ({
    statusCode: 200,
    stream: fakeAudioStream(),
    headers: new Headers(),
    blob: {
      url: BLOB_URL,
      downloadUrl: BLOB_URL,
      pathname: `audio/${NOTE_ID}/${SEQ}`,
      contentDisposition: "",
      cacheControl: "",
      uploadedAt: new Date(),
      etag: "etag",
      contentType: MIME_TYPE,
      size: 3,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forme minimale suffisante pour le test.
  })) as any;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/transcribe", () => {
  beforeEach(() => {
    resetRateLimitStateForTests();
    vi.clearAllMocks();
    stubOwnedBlob();
    stubAudioDownload();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("succès (groq, provider par défaut) : 200 avec le transcript assemblable", async () => {
    vi.stubEnv("TRANSCRIBE_PROVIDER", "groq");
    vi.stubEnv("GROQ_API_KEY", "sk-groq-test");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { text: "bonjour", language: "fr", duration: 3.2 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(transcribeRequest(validBody({ lang: "fr" })));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({
      noteId: NOTE_ID,
      seq: SEQ,
      text: "bonjour",
      language: "fr",
      provider: "groq",
      durationMs: 3200,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      expect.anything(),
    );
    // Revue C4 : la route et les providers passent par `@/lib/blob/store`
    // (seule porte d'entrée du SDK Blob dans le projet), jamais par
    // `@vercel/blob` directement — c'est cette couche qui injecte le jeton.
    expect(headBlob).toHaveBeenCalledWith(BLOB_URL);
    expect(getBlobStream).toHaveBeenCalledWith(BLOB_URL, { abortSignal: undefined });
  });

  it("succès (openai) : 200, appelle bien l'API OpenAI", async () => {
    vi.stubEnv("TRANSCRIBE_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-test");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { text: "hello", language: "en", duration: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(transcribeRequest(validBody()));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.provider).toBe("openai");
    expect(json.text).toBe("hello");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.anything(),
    );
  });

  it("succès (gladia) : 200, suit le cycle upload → init → poll", async () => {
    vi.stubEnv("TRANSCRIBE_PROVIDER", "gladia");
    vi.stubEnv("GLADIA_API_KEY", "gk-test");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { audio_url: "https://api.gladia.io/files/abc" }))
      .mockResolvedValueOnce(
        jsonResponse(201, { id: "job-1", result_url: "https://api.gladia.io/v2/pre-recorded/job-1" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: "done",
          result: { transcription: { full_transcript: "goedendag", languages: ["nl"] } },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(transcribeRequest(validBody({ lang: "nl" })));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({ provider: "gladia", text: "goedendag", language: "nl" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("erreur transitoire (503) : réessaie et finit par réussir", async () => {
    vi.stubEnv("TRANSCRIBE_PROVIDER", "groq");
    vi.stubEnv("GROQ_API_KEY", "sk-groq-test");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("service unavailable", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(200, { text: "après réessai", language: "fr" }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(transcribeRequest(validBody()));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.text).toBe("après réessai");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("erreur définitive (401, clé refusée) : échoue immédiatement, sans réessayer", async () => {
    vi.stubEnv("TRANSCRIBE_PROVIDER", "groq");
    vi.stubEnv("GROQ_API_KEY", "sk-groq-mauvaise");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { error: { message: "Invalid API Key", type: "invalid_request_error" } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(transcribeRequest(validBody()));

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json).toEqual({
      error: "SERVER_MISCONFIGURED",
      message: "Configuration du serveur invalide. Contacte l'administrateur.",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("TRANSCRIBE_PROVIDER invalide → échec explicite, pas de repli silencieux", async () => {
    vi.stubEnv("TRANSCRIBE_PROVIDER", "bogus-provider");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(transcribeRequest(validBody()));

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("SERVER_MISCONFIGURED");
    expect(json.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clé API absente → message français, pas d'appel réseau", async () => {
    vi.stubEnv("TRANSCRIBE_PROVIDER", "groq");
    delete process.env.GROQ_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(transcribeRequest(validBody()));

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("SERVER_MISCONFIGURED");
    expect(json.message).toMatch(/administrateur/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("corps invalide (JSON malformé) → 400 BAD_REQUEST", async () => {
    const response = await POST(transcribeRequest(undefined, { rawBody: "{ pas du json" }));
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toEqual({ error: "BAD_REQUEST", message: "Requête invalide.", retryable: false });
  });

  it.each([
    ["noteId manquant", { noteId: undefined }],
    ["noteId pas un UUID", { noteId: "note-1" }],
    ["seq négatif", { seq: -1 }],
    ["seq non entier", { seq: 1.5 }],
    ["mimeType hors liste blanche", { mimeType: "video/mp4" }],
    ["lang invalide", { lang: "de" }],
    ["blobUrl n'est pas une URL", { blobUrl: "pas-une-url" }],
  ])("corps invalide (%s) → 400 BAD_REQUEST", async (_label, overrides) => {
    const response = await POST(transcribeRequest(validBody(overrides)));
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("BAD_REQUEST");
  });

  it("blobUrl étranger à notre store (mauvais pathname) → refus, jamais téléchargé", async () => {
    stubOwnedBlob("audio/550e8400-e29b-41d4-a716-000000000000/0");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(transcribeRequest(validBody()));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("BAD_REQUEST");
    expect(vi.mocked(getBlobStream)).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Revue BLOQUANTE B3 (2026-08-26) : headBlob() doit classer ses erreurs par
  // nature — un blob vraiment introuvable n'est pas une panne d'infra, et
  // réciproquement. Un `catch` nu qui renverrait 400 dans tous les cas
  // condamnerait définitivement (retryable:false) un segment déjà uploadé à
  // la moindre panne passagère du service Blob.
  it("blobUrl vraiment introuvable dans notre store (BlobNotFoundError) → 400, non réessayable", async () => {
    vi.mocked(headBlob).mockRejectedValue(namedError("BlobNotFoundError"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(transcribeRequest(validBody()));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toEqual({
      error: "BAD_REQUEST",
      message: "Ce lien audio n'est pas valide pour cette note.",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["BlobServiceNotAvailable", "BlobServiceRateLimited"])(
    "panne passagère du service Blob (%s) à headBlob() → 503 PROVIDER_UNAVAILABLE, réessayable (jamais un verdict définitif)",
    async (name) => {
      vi.mocked(headBlob).mockRejectedValue(namedError(name));
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const response = await POST(transcribeRequest(validBody()));

      expect(response.status).toBe(503);
      const json = await response.json();
      expect(json).toMatchObject({ error: "PROVIDER_UNAVAILABLE", retryable: true });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("erreur réseau ou inconnue (sans nom reconnu) à headBlob() → 503 PROVIDER_UNAVAILABLE, réessayable", async () => {
    vi.mocked(headBlob).mockRejectedValue(new TypeError("fetch failed"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(transcribeRequest(validBody()));

    expect(response.status).toBe(503);
    const json = await response.json();
    expect(json).toMatchObject({ error: "PROVIDER_UNAVAILABLE", retryable: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["BlobAccessError", "BlobStoreNotFoundError"])(
    "jeton sans accès à ce store (%s) à headBlob() → 500 SERVER_MISCONFIGURED, non réessayable",
    async (name) => {
      vi.mocked(headBlob).mockRejectedValue(namedError(name));
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const response = await POST(transcribeRequest(validBody()));

      expect(response.status).toBe(500);
      const json = await response.json();
      expect(json).toEqual({
        error: "SERVER_MISCONFIGURED",
        message: "Configuration du serveur invalide. Contacte l'administrateur.",
        retryable: false,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("BLOB_READ_WRITE_TOKEN absent (BlobConfigError depuis headBlob()) → 500 SERVER_MISCONFIGURED, non réessayable", async () => {
    vi.mocked(headBlob).mockRejectedValue(
      namedError(
        "BlobConfigError",
        "Le stockage audio n'est pas configuré (BLOB_READ_WRITE_TOKEN manquant).",
      ),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(transcribeRequest(validBody()));

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("SERVER_MISCONFIGURED");
    expect(json.retryable).toBe(false);
    expect(vi.mocked(getBlobStream)).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("body volumineux (au lieu de la seule URL du blob) → 413, jamais traité", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const oversized = "x".repeat(200 * 1024); // très au-delà des ~8 Ko attendus pour ce JSON.

    const response = await POST(transcribeRequest(undefined, { rawBody: oversized }));

    expect(response.status).toBe(413);
    const json = await response.json();
    expect(json.error).toBe("PAYLOAD_TOO_LARGE");
    expect(json.retryable).toBe(false);
    expect(vi.mocked(headBlob)).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("body volumineux annoncé par Content-Length → 413 avant même de lire le flux", async () => {
    const request = new Request("http://localhost/api/transcribe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(10 * 1024 * 1024),
        "x-forwarded-for": freshIp(),
      },
      body: JSON.stringify(validBody()),
    });

    const response = await POST(request);
    expect(response.status).toBe(413);
  });

  it("rate limiting : au-delà de la limite par IP → 429", async () => {
    vi.stubEnv("TRANSCRIBE_PROVIDER", "groq");
    vi.stubEnv("GROQ_API_KEY", "sk-groq-test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(jsonResponse(200, { text: "ok", language: "fr" })),
      ),
    );
    const ip = freshIp();

    for (let i = 0; i < 40; i += 1) {
      const response = await POST(transcribeRequest(validBody(), { ip }));
      expect(response.status).toBe(200);
    }

    const response = await POST(transcribeRequest(validBody(), { ip }));
    expect(response.status).toBe(429);
    const json = await response.json();
    expect(json).toEqual({
      error: "RATE_LIMITED",
      message: "Trop de demandes de transcription en peu de temps. Réessaie dans quelques minutes.",
      retryable: true,
    });
  });
});
