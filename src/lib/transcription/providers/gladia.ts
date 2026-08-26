/**
 * Gladia — option d'hébergement UE (voir `docs/PROVIDER-TRANSCRIPTION.md`).
 * API v2 volontairement différente de Groq/OpenAI, donc pas de mutualisation
 * avec `openai-compatible.ts` :
 *
 *   1. `POST /v2/upload` (multipart, champ `audio`) : dépose le fichier chez
 *      Gladia et récupère un `audio_url` HÉBERGÉ CHEZ EUX. Indispensable ici
 *      car notre blob est privé — Gladia ne pourrait pas le récupérer tout
 *      seul avec `audio_url` pointant vers notre store sans notre jeton.
 *   2. `POST /v2/pre-recorded` avec cet `audio_url` : démarre le job, renvoie
 *      `result_url`.
 *   3. On interroge `result_url` jusqu'à `status: "done"` (ou `"error"`).
 *
 * Le job Gladia est interne à cet appel : le client de VoxNote ne voit
 * jamais cette asynchronie, conformément à la route `/api/transcribe`
 * (synchrone, un appel par segment — voir `src/types/api.ts`). Le polling
 * est borné pour rester sous `maxDuration` de la route (voir
 * `src/app/api/transcribe/route.ts`).
 */

import { downloadBlobAudio } from "../audio-source";
import {
  audioUnreadableError,
  providerQuotaError,
  providerUnavailableError,
  serverMisconfiguredError,
  type TranscriptionError,
} from "../errors";
import type {
  TranscribeInput,
  TranscriptionProvider,
  TranscriptionResult,
} from "../types";

const GLADIA_BASE_URL = "https://api.gladia.io/v2";

// 40 tentatives × 2 s = 80 s de polling au pire, en plus du téléchargement,
// de l'upload et de l'initialisation : reste sous les 120 s de `maxDuration`
// avec de la marge. Un segment de ~5 min a largement le temps d'être transcrit
// avant cette borne (Gladia annonce 30-60 s pour 10 min d'audio).
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_POLL_ATTEMPTS = 40;

export interface GladiaProviderOptions {
  /** Injectable pour les tests — jamais d'appel réseau réel dans la suite. */
  fetchImpl?: typeof fetch;
  /** Injectable pour les tests : évite d'attendre pour de vrai entre deux sondages. */
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

interface GladiaUploadResponse {
  audio_url: string;
}

interface GladiaInitResponse {
  id: string;
  result_url: string;
}

interface GladiaPollResponse {
  status: "queued" | "processing" | "done" | "error";
  error_code?: number;
  result?: {
    transcription?: {
      full_transcript?: string;
      languages?: string[];
    };
  };
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
};

function filenameForMimeType(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const extension = EXTENSION_BY_MIME[base] ?? "audio";
  return `segment.${extension}`;
}

/**
 * Valide `result_url` (renvoyé par l'init du job) et le ramène à un chemin
 * relatif à `GLADIA_BASE_URL`, pour réutiliser `callGladia`.
 *
 * Revue S5 (2026-08-26) : un simple `job.result_url.replace(GLADIA_BASE_URL, "")`
 * lève un `TypeError` non typé si `result_url` est absent ou n'est pas une
 * chaîne (le cast `as GladiaInitResponse` ne garantit rien à l'exécution),
 * qui remontait alors en 500 non réessayable au lieu d'une erreur classifiée.
 * `new URL(...)` avec contrôle d'origine ET de préfixe de chemin est plus
 * honnête : une réponse Gladia mal formée devient une `TranscriptionError`
 * explicite, pas un plantage.
 */
function parseGladiaResultPath(resultUrl: unknown): string {
  if (typeof resultUrl !== "string" || resultUrl.length === 0) {
    throw audioUnreadableError(
      "Réponse Gladia invalide : result_url manquant à l'initialisation du job.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(resultUrl);
  } catch {
    throw audioUnreadableError(
      `Réponse Gladia invalide : result_url mal formée (${resultUrl}).`,
    );
  }

  const base = new URL(GLADIA_BASE_URL);
  if (parsed.origin !== base.origin || !parsed.pathname.startsWith(base.pathname)) {
    throw audioUnreadableError(
      `Réponse Gladia invalide : result_url hors du domaine ou du chemin attendu (${resultUrl}).`,
    );
  }

  return `${parsed.pathname.slice(base.pathname.length)}${parsed.search}`;
}

/** Classification par code de statut HTTP, identique en esprit à celle des providers compatibles OpenAI. */
function translateStatusError(status: number, detail: string): TranscriptionError {
  if (status === 401 || status === 403) {
    return serverMisconfiguredError(`Clé API Gladia refusée (HTTP ${status}). ${detail}`);
  }
  if (status === 429) {
    // Gladia ne documente pas publiquement de distinction rate-limit vs.
    // quota épuisé dans le corps de la réponse 429 : on retente par défaut,
    // c'est le cas le plus fréquent (débit), et 3 tentatives coûtent peu.
    return providerQuotaError(true, `Gladia a répondu 429. ${detail}`);
  }
  if (status >= 500) {
    return providerUnavailableError(`Gladia a répondu ${status}. ${detail}`);
  }
  return audioUnreadableError(`Gladia a répondu ${status}. ${detail}`);
}

export function createGladiaProvider(
  options: GladiaProviderOptions = {},
): TranscriptionProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPollAttempts = options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;

  async function callGladia(
    apiKey: string,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    try {
      return await fetchImpl(`${GLADIA_BASE_URL}${path}`, {
        ...init,
        headers: { "x-gladia-key": apiKey, ...init.headers },
      });
    } catch (error) {
      throw providerUnavailableError(
        `Échec réseau vers gladia (${path}) : ${(error as Error).message ?? "erreur inconnue"}.`,
      );
    }
  }

  return {
    id: "gladia",
    async transcribe({
      audioUrl,
      mimeType,
      language,
      signal,
    }: TranscribeInput): Promise<TranscriptionResult> {
      const apiKey = process.env.GLADIA_API_KEY;
      if (!apiKey) {
        throw serverMisconfiguredError(
          "GLADIA_API_KEY est manquant. Configure la variable d'environnement " +
            "Vercel avant de redéployer.",
        );
      }

      const started = Date.now();
      const { bytes, contentType } = await downloadBlobAudio(audioUrl, signal);

      // 1. Dépôt du fichier chez Gladia (notre blob est privé, voir
      // commentaire de module).
      const uploadForm = new FormData();
      uploadForm.set(
        "audio",
        new Blob([bytes], { type: mimeType || contentType }),
        filenameForMimeType(mimeType || contentType),
      );
      const uploadResponse = await callGladia(apiKey, "/upload", {
        method: "POST",
        body: uploadForm,
        signal,
      });
      if (!uploadResponse.ok) {
        throw translateStatusError(uploadResponse.status, "Échec du dépôt du fichier.");
      }
      const upload = (await uploadResponse.json()) as GladiaUploadResponse;

      // 2. Démarrage du job de transcription.
      const initBody: Record<string, unknown> = { audio_url: upload.audio_url };
      if (language) {
        initBody.language_config = { languages: [language] };
      }
      const initResponse = await callGladia(apiKey, "/pre-recorded", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(initBody),
        signal,
      });
      if (!initResponse.ok) {
        throw translateStatusError(initResponse.status, "Échec du démarrage de la transcription.");
      }
      const job = (await initResponse.json()) as GladiaInitResponse;

      // 3. Sondage borné du résultat.
      const resultPath = parseGladiaResultPath(job.result_url);
      for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
        const pollResponse = await callGladia(apiKey, resultPath, {
          method: "GET",
          signal,
        });
        if (!pollResponse.ok) {
          throw translateStatusError(pollResponse.status, "Échec de la lecture du résultat.");
        }
        const poll = (await pollResponse.json()) as GladiaPollResponse;

        if (poll.status === "done") {
          const transcript = poll.result?.transcription;
          return {
            text: transcript?.full_transcript ?? "",
            language: transcript?.languages?.[0] ?? language ?? "und",
            durationMs: Date.now() - started,
            provider: "gladia",
          };
        }
        if (poll.status === "error") {
          throw translateStatusError(
            poll.error_code ?? 500,
            "Le job Gladia s'est terminé en erreur.",
          );
        }
        await sleep(pollIntervalMs);
      }

      // Le job n'a pas terminé dans le budget imparti : traité comme une
      // indisponibilité transitoire (retryable), pas comme un audio illisible.
      throw providerUnavailableError(
        `Gladia n'a pas terminé après ${maxPollAttempts} sondages (${job.id}).`,
      );
    },
  };
}
