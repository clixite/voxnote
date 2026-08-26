import { NextResponse, type NextRequest } from "next/server";

import { AuthConfigError } from "@/lib/auth/env";
import { sanitizeRedirectPath } from "@/lib/auth/redirect";
import { COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";

// Fichier nommé `middleware.ts` (et non `proxy.ts`) délibérément : depuis
// Next.js 16, `proxy.ts` tourne uniquement en runtime Node, alors que
// `middleware.ts` conserve le runtime Edge. On en a besoin ici pour que
// `computePasswordVersion` (Web Crypto) tourne sans dépendre de bcryptjs,
// indisponible et de toute façon bien trop lent pour s'exécuter à chaque
// requête. Ce fichier ne fait QUE vérifier le JWT et le `pv` — il n'appelle
// jamais bcryptjs.

const SERVER_ERROR_MESSAGE =
  "Configuration du serveur invalide. Contacte l'administrateur.";

function serverErrorResponse(isApiRoute: boolean): NextResponse {
  if (isApiRoute) {
    return NextResponse.json(
      { error: "SERVER_MISCONFIGURED", message: SERVER_ERROR_MESSAGE },
      { status: 500 },
    );
  }
  return new NextResponse(SERVER_ERROR_MESSAGE, {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isApiRoute = pathname.startsWith("/api/");
  const token = request.cookies.get(COOKIE_NAME)?.value;

  let authenticated: boolean;
  try {
    authenticated = await verifySessionToken(token);
  } catch (error) {
    if (error instanceof AuthConfigError) {
      return serverErrorResponse(isApiRoute);
    }
    throw error;
  }

  if (authenticated) {
    return NextResponse.next();
  }

  if (isApiRoute) {
    return NextResponse.json(
      {
        error: "UNAUTHENTICATED",
        message: "Session expirée. Reconnecte-toi.",
      },
      { status: 401 },
    );
  }

  // `pathname` peut, sur une requête forgée (ex. `https://host//evil.com`),
  // valoir littéralement "//evil.com" : on le fait passer par le même
  // validateur que celui destiné à l'écran de connexion, pour ne jamais
  // propager un `from` exploitable en redirection ouverte.
  const from = sanitizeRedirectPath(`${pathname}${search}`);
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("from", from);
  return NextResponse.redirect(loginUrl, 307);
}

export const config = {
  // Next.js exige que chaque `matcher` commence littéralement par "/" (le
  // build échoue sinon : "source must start with /"), donc pas d'ancre `^`
  // explicite ici. Next compile ce motif en interne comme un match complet
  // du pathname (voir `middleware.test.ts`, qui reproduit cet ancrage pour
  // tester le motif isolément) — un chemin comme "/api/auth/login" est bien
  // exclu en pratique, ce n'est qu'un `new RegExp(pattern).test()` nu, sans
  // ancrage, qui s'y tromperait en retentant un match plus loin dans la
  // chaîne.
  //
  // `api/cron/purge$` : chemin EXACT, jamais un préfixe (`api/cron/`). Vercel
  // Cron appelle cette seule route sans cookie de session (elle vérifie
  // `CRON_SECRET` elle-même, voir `src/app/api/cron/purge/route.ts`) ; un
  // préfixe ouvrirait tout un sous-arbre `api/cron/*` aux appels anonymes,
  // y compris des routes qui n'ont pas cette vérification.
  matcher: [
    "/((?!login$|confidentialite$|api/auth/login$|api/auth/logout$|api/cron/purge$|manifest\\.webmanifest$|sw\\.js$|icon\\.png$|apple-icon\\.png$|icons/|_next/|favicon\\.ico$).*)",
  ],
};
