import { NextResponse } from "next/server";

import { AuthConfigError, getAuthConfig } from "@/lib/auth/env";
import { getClientIp } from "@/lib/auth/ip";
import { verifyPassword } from "@/lib/auth/password";
import { buildSessionCookie, createSessionToken } from "@/lib/auth/session";
import {
  isThrottled,
  recordFailedAttempt,
  resetAttempts,
} from "@/lib/auth/throttle";

// bcryptjs est pur JS mais coûteux (~100 ms/essai) et cette route doit
// pouvoir l'exécuter : runtime Node explicite, jamais edge.
export const runtime = "nodejs";

function badRequest() {
  return NextResponse.json(
    { error: "BAD_REQUEST", message: "Requête invalide." },
    { status: 400 },
  );
}

function serverMisconfigured() {
  return NextResponse.json(
    {
      error: "SERVER_MISCONFIGURED",
      message: "Configuration du serveur invalide. Contacte l'administrateur.",
    },
    { status: 500 },
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest();
  }

  if (typeof body !== "object" || body === null || !("password" in body)) {
    return badRequest();
  }
  const { password } = body as { password: unknown };
  if (typeof password !== "string" || password.length === 0) {
    return badRequest();
  }
  const ip = getClientIp(request);

  let authConfig;
  try {
    authConfig = getAuthConfig();
  } catch (error) {
    if (error instanceof AuthConfigError) return serverMisconfigured();
    throw error;
  }

  if (isThrottled(ip)) {
    return NextResponse.json(
      {
        error: "TOO_MANY_ATTEMPTS",
        message: "Trop de tentatives. Réessaie dans quelques minutes.",
      },
      { status: 429 },
    );
  }

  const valid = await verifyPassword(password, authConfig.appPasswordHash);
  if (!valid) {
    recordFailedAttempt(ip);
    return NextResponse.json(
      { error: "INVALID_PASSWORD", message: "Mot de passe incorrect." },
      { status: 401 },
    );
  }

  resetAttempts(ip);
  const token = await createSessionToken();

  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(buildSessionCookie(token));
  return response;
}
