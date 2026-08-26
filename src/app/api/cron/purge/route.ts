import { NextResponse } from "next/server";

import { BlobConfigError } from "@/lib/blob/env";
import { deleteBlobs, listBlobsByPrefix } from "@/lib/blob/store";
import { AUDIO_PREFIX } from "@/lib/blob/validation";
import {
  AUDIO_RETENTION_DAYS,
  type ApiErrorBody,
  type PurgeResponseBody,
} from "@/types/api";

// Runtime Node explicite (déjà le défaut des route handlers), par cohérence
// avec `src/app/api/blob/upload-token/route.ts`, qui en dépend réellement
// (voir `src/lib/blob/store.ts`).
export const runtime = "nodejs";

const RETENTION_MS = AUDIO_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function jsonError(body: ApiErrorBody, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

/**
 * Vercel Cron appelle cette route avec `Authorization: Bearer <CRON_SECRET>`
 * (comportement documenté de la plateforme quand `CRON_SECRET` est défini
 * sur le projet). On vérifie ici, explicitement — jamais dans le middleware,
 * qui exclut cette route exacte (`src/middleware.ts`) puisque Vercel Cron
 * appelle sans cookie de session.
 *
 * Absence de `CRON_SECRET` ⇒ refus, jamais un défaut permissif : un secret
 * manquant ne doit jamais se traduire par une route cron ouverte à tous.
 */
function isAuthorizedCronRequest(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const authorization = request.headers.get("authorization");
  return authorization === `Bearer ${expected}`;
}

/**
 * Purge les blobs audio de plus de `AUDIO_RETENTION_DAYS` jours, toutes
 * notes confondues. Voir `src/types/api.ts` (`PurgeResponseBody`).
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(request)) {
    return jsonError(
      {
        error: "UNAUTHENTICATED",
        message: "Authentification cron invalide.",
        retryable: false,
      },
      401,
    );
  }

  try {
    const blobs = await listBlobsByPrefix(AUDIO_PREFIX);
    const cutoff = Date.now() - RETENTION_MS;
    const expired = blobs.filter((blob) => blob.uploadedAt.getTime() < cutoff);

    await deleteBlobs(expired.map((blob) => blob.url));

    const response: PurgeResponseBody = {
      scanned: blobs.length,
      deleted: expired.length,
    };
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof BlobConfigError) {
      return jsonError(
        {
          error: "SERVER_MISCONFIGURED",
          message: error.message,
          retryable: false,
        },
        500,
      );
    }
    return jsonError(
      {
        error: "PROVIDER_UNAVAILABLE",
        message: "La purge automatique a échoué. Réessaie plus tard.",
        retryable: true,
      },
      502,
    );
  }
}
