import type { Page, Route } from "@playwright/test";

import type { ApiErrorBody, TranscribeResponseBody } from "@/types/api";

/**
 * Simule, au niveau du navigateur (`page.route`), tout le pipeline serveur
 * du ticket P3-7 : jeton d'upload Blob, upload direct vers Blob, et
 * `/api/transcribe`. Nécessaire car cet environnement n'a ni token Vercel
 * Blob ni clé de transcription réelle (voir le rapport du ticket) — ceci
 * n'est PAS un test contre le vrai code serveur, seulement contre l'exécution
 * réelle du client (`@vercel/blob/client`, `fetch`) dans un vrai navigateur.
 *
 * Comportement du SDK vérifié empiriquement sur `@vercel/blob@2.8.0` (pas de
 * documentation officielle consultée pour ce détail d'implémentation) :
 * `upload()` de `@vercel/blob/client` appelle d'abord `handleUploadUrl`
 * (notre route `/api/blob/upload-token`) avec `{type: "blob.generate-client-token"}`
 * pour obtenir un jeton, PUIS fait un `PUT` direct vers
 * `https://vercel.com/api/blob/?pathname=...` (URL par défaut du SDK, sans
 * `VERCEL_BLOB_API_URL`, jamais configurée dans ce projet). C'est ce PUT,
 * jamais notre route API, qui reçoit le binaire audio — cohérent avec la
 * contrainte n°3 du projet (l'audio ne transite jamais par une route API).
 *
 * IMPORTANT — retries internes du SDK : la route de jeton
 * (`retrieveClientToken`) ne fait AUCUN retry interne, un échec s'y propage
 * immédiatement comme un rejet `fetch` classique. Le PUT vers le stockage
 * Blob, lui, est enveloppé par `async-retry` côté SDK avec 10 tentatives par
 * défaut : le faire échouer délibérément dans un test ferait attendre
 * plusieurs dizaines de secondes avant que l'erreur ne remonte à notre file
 * d'upload. Pour cette raison, aucun scénario de ce fichier ne simule un
 * échec sur le PUT Blob lui-même — uniquement sur la route de jeton ou sur
 * `/api/transcribe`, jamais enveloppées par ce retry SDK.
 */

const BLOB_STORAGE_PATTERN = "https://vercel.com/api/blob/**";
const UPLOAD_TOKEN_PATTERN = "**/api/blob/upload-token";
const TRANSCRIBE_PATTERN = "**/api/transcribe";

export interface TranscribeMockRequestInfo {
  noteId: string;
  seq: number;
  blobUrl: string;
  mimeType: string;
  lang: string;
  /** Numéro de tentative pour CE segment (1 = premier appel). */
  attempt: number;
}

export type TranscribeMockOutcome =
  | { ok: true; text?: string; provider?: string; language?: string; durationMs?: number }
  | { ok: false; status: number; body: ApiErrorBody };

export type TranscribeHandler = (
  info: TranscribeMockRequestInfo,
) => TranscribeMockOutcome | Promise<TranscribeMockOutcome>;

const defaultTranscribeHandler: TranscribeHandler = (info) => ({
  ok: true,
  text: `Texte transcrit segment ${info.seq}`,
});

export interface BlobPipelineMock {
  /** Nombre d'appels `type: "blob.generate-client-token"`, tous segments confondus. */
  tokenCallCount: number;
  /** `seq` de chaque appel de jeton, dans l'ordre d'arrivée (répétitions incluses en cas de nouvel essai). */
  tokenCallSeqs: number[];
  /** Nombre d'appels au PUT direct vers le stockage Blob. */
  blobPutCallCount: number;
  /** Nombre total d'appels à `/api/transcribe`, tous segments confondus. */
  transcribeCallCount: number;
  /** Détail de chaque appel à `/api/transcribe`, dans l'ordre d'arrivée. */
  transcribeCalls: TranscribeMockRequestInfo[];
  /**
   * `seq` de chaque réponse `/api/transcribe`, dans l'ordre où elle a été
   * ENVOYÉE (pas reçue) — sert à prouver qu'un test a bien fait répondre le
   * serveur simulé dans le désordre par rapport à `seq`.
   */
  transcribeCompletionOrderSeqs: number[];
  /** Pic de requêtes simultanées observé, toutes routes mockées confondues (voir P3-7 : jamais > 3). */
  maxConcurrentRequests: number;
  /** Remplace la réponse de `/api/transcribe` pour les appels à venir. */
  setTranscribeHandler(handler: TranscribeHandler): void;
  /** Délai artificiel (ms) avant de répondre à la génération de jeton, par segment. */
  setTokenDelayMs(delayForSeq: (seq: number) => number): void;
  /** Délai artificiel (ms) avant de répondre au PUT Blob, par segment. */
  setPutDelayMs(delayForSeq: (seq: number) => number): void;
  /** Délai artificiel (ms) avant de répondre à `/api/transcribe`, par segment. */
  setTranscribeDelayMs(delayForSeq: (seq: number) => number): void;
}

/**
 * Installe les trois interceptions. À appeler avant `page.goto` (comme
 * `installFakeMicrophone`) pour couvrir aussi les requêtes émises tout de
 * suite après le premier rendu.
 */
export async function installBlobPipelineMocks(page: Page): Promise<BlobPipelineMock> {
  const attemptsBySegment = new Map<string, number>();
  let tokenCallCount = 0;
  const tokenCallSeqs: number[] = [];
  let blobPutCallCount = 0;
  let transcribeCallCount = 0;
  const transcribeCalls: TranscribeMockRequestInfo[] = [];
  const transcribeCompletionOrderSeqs: number[] = [];
  let concurrent = 0;
  let maxConcurrentRequests = 0;
  let transcribeHandler: TranscribeHandler = defaultTranscribeHandler;
  let tokenDelayForSeq: (seq: number) => number = () => 0;
  let putDelayForSeq: (seq: number) => number = () => 0;
  let transcribeDelayForSeq: (seq: number) => number = () => 0;

  function enterConcurrent(): void {
    concurrent += 1;
    if (concurrent > maxConcurrentRequests) maxConcurrentRequests = concurrent;
  }
  function exitConcurrent(): void {
    concurrent -= 1;
  }
  function delay(ms: number): Promise<void> {
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
  }

  await page.route(UPLOAD_TOKEN_PATTERN, async (route: Route) => {
    const request = route.request();
    let parsedBody: { type?: string; payload?: { pathname?: string; clientPayload?: string } };
    try {
      parsedBody = JSON.parse(request.postData() ?? "{}");
    } catch {
      await route.continue();
      return;
    }

    if (parsedBody.type !== "blob.generate-client-token") {
      // "blob.upload-completed" : callback serveur-à-serveur en production,
      // jamais émis par le navigateur dans nos scénarios (voir le
      // commentaire de tête) — répondu par prudence, ne devrait pas arriver.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ type: parsedBody.type, response: "ok" }),
      });
      return;
    }

    let seq = -1;
    try {
      const clientPayload = JSON.parse(parsedBody.payload?.clientPayload ?? "{}") as { seq?: number };
      seq = typeof clientPayload.seq === "number" ? clientPayload.seq : -1;
    } catch {
      // payload illisible : laissé à -1, seul le comptage global reste fiable.
    }

    tokenCallCount += 1;
    tokenCallSeqs.push(seq);

    enterConcurrent();
    await delay(tokenDelayForSeq(seq));
    exitConcurrent();

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        type: parsedBody.type,
        clientToken: `vercel_blob_client_test_token_${tokenCallCount}`,
      }),
    });
  });

  await page.route(BLOB_STORAGE_PATTERN, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.searchParams.get("pathname") ?? "audio/unknown/0";
    const seq = Number(pathname.split("/").pop());

    blobPutCallCount += 1;
    enterConcurrent();
    await delay(putDelayForSeq(Number.isFinite(seq) ? seq : -1));
    exitConcurrent();

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url: `https://fake-store.public.blob.vercel-storage.com/${pathname}`,
        downloadUrl: `https://fake-store.public.blob.vercel-storage.com/${pathname}?download=1`,
        pathname,
        contentType: "audio/webm",
        contentDisposition: `attachment; filename="${pathname}"`,
      }),
    });
  });

  await page.route(TRANSCRIBE_PATTERN, async (route: Route) => {
    const request = route.request();
    let body: { noteId: string; seq: number; blobUrl: string; mimeType: string; lang: string };
    try {
      body = JSON.parse(request.postData() ?? "{}");
    } catch {
      await route.continue();
      return;
    }

    const key = `${body.noteId}:${body.seq}`;
    const attempt = (attemptsBySegment.get(key) ?? 0) + 1;
    attemptsBySegment.set(key, attempt);

    const info: TranscribeMockRequestInfo = {
      noteId: body.noteId,
      seq: body.seq,
      blobUrl: body.blobUrl,
      mimeType: body.mimeType,
      lang: body.lang,
      attempt,
    };
    transcribeCallCount += 1;
    transcribeCalls.push(info);

    enterConcurrent();
    await delay(transcribeDelayForSeq(body.seq));
    const outcome = await transcribeHandler(info);
    exitConcurrent();
    transcribeCompletionOrderSeqs.push(body.seq);

    if (outcome.ok) {
      const responseBody: TranscribeResponseBody = {
        noteId: body.noteId,
        seq: body.seq,
        text: outcome.text ?? `Texte transcrit segment ${body.seq}`,
        language: outcome.language ?? "fr",
        provider: (outcome.provider ?? "groq") as TranscribeResponseBody["provider"],
        durationMs: outcome.durationMs ?? 1000,
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responseBody) });
    } else {
      await route.fulfill({
        status: outcome.status,
        contentType: "application/json",
        body: JSON.stringify(outcome.body),
      });
    }
  });

  return {
    get tokenCallCount() {
      return tokenCallCount;
    },
    tokenCallSeqs,
    get blobPutCallCount() {
      return blobPutCallCount;
    },
    get transcribeCallCount() {
      return transcribeCallCount;
    },
    transcribeCalls,
    transcribeCompletionOrderSeqs,
    get maxConcurrentRequests() {
      return maxConcurrentRequests;
    },
    setTranscribeHandler(handler: TranscribeHandler) {
      transcribeHandler = handler;
    },
    setTokenDelayMs(fn: (seq: number) => number) {
      tokenDelayForSeq = fn;
    },
    setPutDelayMs(fn: (seq: number) => number) {
      putDelayForSeq = fn;
    },
    setTranscribeDelayMs(fn: (seq: number) => number) {
      transcribeDelayForSeq = fn;
    },
  };
}

/** Corps d'erreur `ApiErrorBody` prêt à l'emploi pour les scénarios de test. */
export function apiError(
  message: string,
  retryable: boolean,
  code: ApiErrorBody["error"] = "AUDIO_UNREADABLE",
): ApiErrorBody {
  return { error: code, message, retryable };
}
