/**
 * Base commune à `groq` et `openai` : les deux exposent la même API HTTP
 * (`POST /audio/transcriptions`, multipart, réponse `verbose_json`) — seules
 * l'URL de base, le modèle et la clé d'environnement changent. Voir
 * `docs/PROVIDER-TRANSCRIPTION.md` : « le coût d'avoir les deux est quasi
 * nul » une fois ce socle factorisé. `gladia.ts` reste séparé : son API
 * (upload puis job asynchrone à interroger) diffère trop pour partager du
 * code sans complexifier les deux.
 */

import type { ProviderId } from "@/types/api";

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

export interface OpenAiCompatibleConfig {
  id: Extract<ProviderId, "groq" | "openai">;
  baseUrl: string;
  model: string;
  /** Nom de la variable d'environnement portant la clé API de ce provider. */
  apiKeyEnvVar: string;
  /** Injectable pour les tests — jamais d'appel réseau réel dans la suite. */
  fetchImpl?: typeof fetch;
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

interface OpenAiCompatibleErrorBody {
  error?: { message?: string; type?: string; code?: string };
}

/**
 * Traduit une réponse HTTP non-`ok` de l'API compatible OpenAI en
 * `TranscriptionError`. Le corps d'erreur (`{ error: { type, code } }`) est
 * lu en best-effort : son absence ou un format inattendu ne doit jamais faire
 * planter la traduction, seulement dégrader la précision de la classification.
 */
async function translateHttpError(
  providerId: ProviderId,
  response: Response,
): Promise<TranscriptionError> {
  let parsed: OpenAiCompatibleErrorBody | undefined;
  try {
    parsed = (await response.json()) as OpenAiCompatibleErrorBody;
  } catch {
    parsed = undefined;
  }
  const errType = parsed?.error?.type ?? "";
  const errCode = parsed?.error?.code ?? "";
  const combined = `${errType} ${errCode}`.toLowerCase();
  const detail = `${providerId} a répondu ${response.status} (${errType || "type inconnu"}${
    errCode ? `/${errCode}` : ""
  }).`;

  if (response.status === 401 || response.status === 403) {
    return serverMisconfiguredError(
      `Clé API ${providerId} refusée (HTTP ${response.status}).`,
    );
  }
  if (response.status === 429) {
    // « rate_limit_exceeded » (débit) est transitoire ; « insufficient_quota »
    // ou un motif de facturation ne le sont pas : rien ne change en 3 essais.
    const hardQuotaExhausted =
      combined.includes("insufficient_quota") || combined.includes("billing");
    return providerQuotaError(!hardQuotaExhausted, detail);
  }
  if (response.status >= 500) {
    return providerUnavailableError(detail);
  }
  // 400 / 404 / 413 / 422 : requête rejetée par le provider — dans notre cas
  // d'usage (un seul champ `file` + `model`), c'est presque toujours parce
  // que le fichier envoyé est vide, tronqué ou dans un format inattendu.
  return audioUnreadableError(detail);
}

export function createOpenAiCompatibleProvider(
  config: OpenAiCompatibleConfig,
): TranscriptionProvider {
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    id: config.id,
    async transcribe({
      audioUrl,
      mimeType,
      language,
      signal,
    }: TranscribeInput): Promise<TranscriptionResult> {
      const apiKey = process.env[config.apiKeyEnvVar];
      if (!apiKey) {
        throw serverMisconfiguredError(
          `${config.apiKeyEnvVar} est manquant. Configure la variable ` +
            "d'environnement Vercel avant de redéployer.",
        );
      }

      const started = Date.now();
      const { bytes, contentType } = await downloadBlobAudio(audioUrl, signal);

      const form = new FormData();
      form.set("model", config.model);
      form.set("response_format", "verbose_json");
      if (language) form.set("language", language);
      form.set(
        "file",
        new Blob([bytes], { type: mimeType || contentType }),
        filenameForMimeType(mimeType || contentType),
      );

      let response: Response;
      try {
        response = await fetchImpl(`${config.baseUrl}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal,
        });
      } catch (error) {
        throw providerUnavailableError(
          `Échec réseau vers ${config.id} : ${(error as Error).message ?? "erreur inconnue"}.`,
        );
      }

      if (!response.ok) {
        throw await translateHttpError(config.id, response);
      }

      let json: { text?: string; language?: string; duration?: number };
      try {
        json = (await response.json()) as typeof json;
      } catch {
        throw audioUnreadableError(
          `Réponse ${config.id} illisible (JSON invalide).`,
        );
      }

      return {
        text: json.text ?? "",
        language: json.language ?? language ?? "und",
        durationMs:
          typeof json.duration === "number"
            ? Math.round(json.duration * 1000)
            : Date.now() - started,
        provider: config.id,
      };
    },
  };
}
