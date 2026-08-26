import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { BlobConfigError } from "@/lib/blob/env";
import { deleteBlobs, listBlobPagesByPrefix } from "@/lib/blob/store";
import { AUDIO_PREFIX } from "@/lib/blob/validation";
import {
  AUDIO_RETENTION_DAYS,
  type ApiErrorBody,
  type PurgeResponseBody,
} from "@/types/api";

// Runtime Node explicite (déjà le défaut des route handlers), par cohérence
// avec `src/app/api/blob/upload-token/route.ts`, qui en dépend réellement
// (voir `src/lib/blob/store.ts`). `timingSafeEqual` ci-dessous en dépend
// aussi directement.
export const runtime = "nodejs";

// Cron quotidien, pas une requête utilisateur : pas d'urgence de latence,
// mais le nombre de blobs à scanner (tout `audio/`, toutes notes confondues)
// n'est pas borné. 60 s est le plafond du plan Vercel Hobby : une valeur qui
// fonctionne sur n'importe quel plan sans configuration supplémentaire de
// l'utilisatrice. Le scan et la suppression se font page par page (voir plus
// bas) : une exécution interrompue par ce délai a déjà supprimé tout ce
// qu'elle a eu le temps de traiter, rien n'est reperdu, et le run du
// lendemain reprend le scan depuis le début.
export const maxDuration = 60;

const RETENTION_MS = AUDIO_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function jsonError(body: ApiErrorBody, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

/** Compare deux chaînes en temps constant, sans jamais appeler `timingSafeEqual` sur des tailles différentes (il lève sinon). */
function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  // Une longueur différente ne fuite rien de sensible ici (elle ne dépend
  // pas du contenu du secret comparé) : c'est uniquement la comparaison
  // OCTET PAR OCTET d'un secret de longueur correcte qui doit être en temps
  // constant.
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
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
 *
 * Comparaison en temps constant (`timingSafeEqual`) plutôt que `===` :
 * exploitation par timing peu réaliste sur une fonction serverless, mais
 * cette route a un pouvoir de suppression de données et le coût de s'en
 * prémunir est nul.
 */
function isAuthorizedCronRequest(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const authorization = request.headers.get("authorization") ?? "";
  return safeEqual(authorization, `Bearer ${expected}`);
}

/**
 * Purge les blobs audio de plus de `AUDIO_RETENTION_DAYS` jours, toutes
 * notes confondues. Voir `src/types/api.ts` (`PurgeResponseBody`).
 *
 * Traite chaque page listée immédiatement (scan + suppression), plutôt que
 * d'accumuler tous les blobs avant la moindre suppression : si une page
 * échoue (listing ou suppression), le travail des pages précédentes reste
 * acquis. Répond `200` avec le décompte réellement accompli même sur un
 * échec partiel — un `502` masquerait ce travail déjà fait, et c'est
 * précisément dans le scénario où la purge rattrape plusieurs jours de
 * retard après un incident que ce travail compte le plus. Vercel Cron ne
 * réessaie de toute façon pas un run en échec : mieux vaut au moins purger ce
 * qui peut l'être aujourd'hui plutôt que de tout reporter à demain.
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

  const cutoff = Date.now() - RETENTION_MS;
  let scanned = 0;
  let deleted = 0;

  try {
    for await (const page of listBlobPagesByPrefix(AUDIO_PREFIX)) {
      scanned += page.length;
      const expired = page.filter((blob) => blob.uploadedAt.getTime() < cutoff);
      if (expired.length === 0) continue;

      try {
        await deleteBlobs(expired.map((blob) => blob.url));
        deleted += expired.length;
      } catch (deleteError) {
        // Une page dont la suppression échoue n'interrompt pas le scan des
        // pages suivantes : voir le commentaire de la fonction.
        console.error(
          "Purge cron : échec de suppression sur une page de blobs, scan poursuivi.",
          deleteError,
        );
      }
    }
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
    if (scanned === 0) {
      // Rien n'a pu être tenté : la toute première page n'a même pas pu
      // être listée. Un vrai échec, pas un succès partiel à rapporter.
      return jsonError(
        {
          error: "PROVIDER_UNAVAILABLE",
          message: "La purge automatique a échoué. Réessaie plus tard.",
          retryable: true,
        },
        502,
      );
    }
    console.error(
      "Purge cron : scan interrompu avant la fin, décompte partiel renvoyé.",
      error,
    );
  }

  const response: PurgeResponseBody = { scanned, deleted };
  return NextResponse.json(response);
}
