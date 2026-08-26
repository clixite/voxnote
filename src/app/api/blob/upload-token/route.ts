import { NextResponse } from "next/server";

import { getClientIp } from "@/lib/auth/ip";
import { BlobConfigError } from "@/lib/blob/env";
import { isRateLimited, recordRequest } from "@/lib/blob/rateLimit";
import { generateUploadToken, type HandleUploadBody } from "@/lib/blob/store";
import {
  blobPathFor,
  parseUploadTokenPayload,
  UploadValidationError,
} from "@/lib/blob/validation";
import { MAX_SEGMENT_BYTES, type ApiErrorBody } from "@/types/api";

// `@vercel/blob/client` (`handleUpload`) utilise le module Node `crypto`
// pour signer les jetons : runtime Node explicite, jamais edge.
export const runtime = "nodejs";

// Sans valeur explicite, `handleUpload` pose `validUntil` à une heure
// (`node_modules/@vercel/blob/dist/client.js`). Combiné à `allowOverwrite:
// true` ci-dessous, un jeton réutilisé pendant cette heure réussit à chaque
// fois au lieu d'être rejeté : un porteur du mot de passe qui intercepte un
// jeton obtient donc une fenêtre d'écritures illimitées de
// `MAX_SEGMENT_BYTES` chacune. Le rate limiting de cette route porte sur
// l'ÉMISSION de jetons (60 par 5 min, voir `rateLimit.ts`), pas sur leur
// consommation : il ne borne donc pas cette fenêtre. Cinq minutes couvrent
// largement l'upload d'un segment de 25 Mo même en 4G médiocre, et divisent
// la fenêtre d'abus par douze par rapport au défaut du SDK.
const UPLOAD_TOKEN_TTL_MS = 5 * 60 * 1000;

function jsonError(body: ApiErrorBody, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

function badRequest(message: string): NextResponse {
  return jsonError({ error: "BAD_REQUEST", message, retryable: false }, 400);
}

function serverMisconfigured(message: string): NextResponse {
  return jsonError(
    { error: "SERVER_MISCONFIGURED", message, retryable: false },
    500,
  );
}

function rateLimited(): NextResponse {
  return jsonError(
    {
      error: "RATE_LIMITED",
      message: "Trop de demandes d'upload. Réessaie dans quelques minutes.",
      retryable: true,
    },
    429,
  );
}

/**
 * Émet un jeton d'upload client direct vers Vercel Blob (voir
 * `src/types/api.ts` pour le contrat complet). Ne reçoit et ne renvoie
 * jamais de binaire audio — uniquement le handshake `@vercel/blob/client`.
 *
 * La session valide est déjà exigée par `src/middleware.ts` pour toute route
 * `/api/*` non listée dans son exclusion ; cette route n'y figure pas.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ip = getClientIp(request);
  if (isRateLimited(ip)) {
    return rateLimited();
  }
  recordRequest(ip);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Requête invalide.");
  }

  try {
    const jsonResponse = await generateUploadToken({
      request,
      body: body as HandleUploadBody,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // Un jeton n'est jamais émis sans ces trois contrôles : mimeType
        // dans la liste blanche, taille sous le plafond, noteId et seq bien
        // formés. Le client peut mentir — c'est ici, et uniquement ici, que
        // ça se décide.
        const payload = parseUploadTokenPayload(clientPayload);

        // Le chemin `audio/{noteId}/{seq}` est contractuel : la suppression
        // et le cron de purge en dépendent pour retrouver les blobs d'une
        // note sans base de données. On refuse tout chemin qui ne
        // correspond pas exactement au payload validé, sans quoi un client
        // pourrait demander un jeton valide pour un chemin hors de ce
        // préfixe.
        if (pathname !== blobPathFor(payload.noteId, payload.seq)) {
          throw new UploadValidationError("Chemin d'upload invalide.");
        }

        return {
          allowedContentTypes: [payload.mimeType],
          // Plafond de la route, pas la taille annoncée par le client : ce
          // qui compte est la limite dure du segment, pas une estimation
          // qui pourrait légèrement varier entre la demande de jeton et
          // l'upload réel.
          maximumSizeInBytes: MAX_SEGMENT_BYTES,
          // Le chemin est déterministe (`audio/{noteId}/{seq}`) : jamais de
          // suffixe aléatoire, sous peine de casser la suppression par
          // préfixe.
          addRandomSuffix: false,
          // Un segment peut être ré-uploadé après un échec réseau partiel
          // détecté à tort par le client (retry de la queue, Phase 3) : la
          // même clé doit alors pouvoir être réécrite plutôt que rejetée.
          // Inoffensif seulement parce que la fenêtre de validité du jeton
          // est courte (voir `UPLOAD_TOKEN_TTL_MS` ci-dessus) : sans elle,
          // cette réécriture illimitée serait le vecteur d'abus principal.
          allowOverwrite: true,
          validUntil: Date.now() + UPLOAD_TOKEN_TTL_MS,
        };
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    if (error instanceof BlobConfigError) {
      return serverMisconfigured(error.message);
    }
    if (error instanceof UploadValidationError) {
      return badRequest(error.message);
    }
    // Tout le reste (JSON malformé côté type d'événement, erreur inattendue
    // du SDK) : jamais de message brut du SDK (anglais, pensé développeur)
    // renvoyé tel quel à l'utilisatrice finale.
    return badRequest("Requête invalide.");
  }
}
