import { NextResponse } from "next/server";

import { buildClearedSessionCookie } from "@/lib/auth/session";

export const runtime = "nodejs";

/**
 * Déconnexion : efface le cookie de session. Idempotente et sans exigence de
 * session valide — appeler `/api/auth/logout` sans cookie (ou avec un
 * cookie déjà invalide) renvoie le même 204.
 */
export async function POST() {
  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(buildClearedSessionCookie());
  return response;
}
