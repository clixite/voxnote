// Imports par sous-chemin (plutôt que le paquet racine `jose`) : on ne
// touche qu'à JWS (signature), jamais à JWE (chiffrement). Cela évite
// d'embarquer le code de déchiffrement de `jose` dans le bundle du
// middleware edge, qui utilise `CompressionStream`/`DecompressionStream` et
// déclenche sinon un faux-positif d'avertissement "API Node.js non supportée
// en Edge Runtime" au build.
import { SignJWT } from "jose/jwt/sign";
import { jwtVerify } from "jose/jwt/verify";

import { AuthConfigError, getAuthConfig } from "./env";
import { computePasswordVersion } from "./pv";

const ALG = "HS256";

export const COOKIE_NAME = "vox_session";
export const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 jours

interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
}

/**
 * Forme structurelle attendue par `NextResponse.cookies.set(...)` — on évite
 * volontairement d'importer un type interne de Next.js (`next/dist/...`),
 * non garanti stable d'une version à l'autre.
 */
interface SessionCookie extends SessionCookieOptions {
  name: string;
  value: string;
}

/**
 * `Secure` doit être actif PAR DÉFAUT, y compris dans tout environnement
 * inconnu — seule une action délibérée doit pouvoir l'enlever.
 *
 * `NODE_ENV` ne permet pas de distinguer "vraie requête HTTPS" de "build de
 * production tournant en local" : `next build && next start` positionne
 * `NODE_ENV=production` aussi bien en déploiement réel qu'en CI (e2e
 * Playwright sur `http://127.0.0.1`). Et WebKit — contrairement à Chromium —
 * refuse purement et simplement de stocker un cookie `Secure` reçu en clair
 * sur `http://127.0.0.1` : ça cassait la session sur `webkit-mobile` (donc
 * Safari iOS, la cible prioritaire) dans les e2e de connexion.
 *
 * Une première version détectait "je tourne sur Vercel" via `VERCEL === "1"`
 * pour activer `Secure`. Le sens de défaillance était le mauvais : l'absence
 * du signal (silencieuse) désactivait `Secure`. Or ce signal peut disparaître
 * en production sans redéploiement ni changement de code — le réglage projet
 * Vercel "Automatically expose System Environment Variables" est désactivable,
 * et `VERCEL` disparaît alors de l'environnement des fonctions. Un cookie de
 * session serait alors posé sans `Secure` sur la toute première requête
 * `http://` avant la redirection HTTPS de la plateforme — une fuite invisible
 * en production, qu'aucun test ne peut voir puisque la CI tourne justement
 * hors plateforme (elle a exactement le même environnement "sans VERCEL").
 *
 * Polarité inversée en conséquence : `Secure` est actif par défaut, et il
 * faut poser explicitement `ALLOW_INSECURE_COOKIES=1` pour l'enlever. Un
 * oubli devient alors un échec visible (session qui ne tient pas en local,
 * détecté par le test ci-dessous et par les e2e) plutôt qu'une fuite
 * invisible en production. Cette variable ne doit JAMAIS être définie en
 * production (voir `.env.example` et `docs/ENVIRONNEMENT.md`) : elle n'a de
 * sens que pour le développement local (`pnpm dev`) et la CI (e2e sur
 * `http://127.0.0.1`), où aucune vraie requête HTTPS n'existe de toute façon.
 */
function shouldUseSecureCookies(): boolean {
  return process.env.ALLOW_INSECURE_COOKIES !== "1";
}

function baseCookieOptions(): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  };
}

/** Cookie de session à poser après une connexion réussie. */
export function buildSessionCookie(token: string): SessionCookie {
  return { name: COOKIE_NAME, value: token, ...baseCookieOptions() };
}

/** Cookie "effacé" à poser lors de la déconnexion. */
export function buildClearedSessionCookie(): SessionCookie {
  return {
    name: COOKIE_NAME,
    value: "",
    ...baseCookieOptions(),
    maxAge: 0,
  };
}

function getSecretKey(authSecret: string): Uint8Array {
  return new TextEncoder().encode(authSecret);
}

/**
 * Émet un nouveau JWT de session. Le seul claim métier est `pv`,
 * l'empreinte du hash de mot de passe en vigueur — aucune donnée
 * personnelle n'est portée par le token.
 *
 * Peut lever `AuthConfigError` si la configuration est invalide : c'est
 * volontaire, l'appelant (route de login) doit traiter cette erreur
 * explicitement plutôt que de la voir absorbée en simple échec d'auth.
 */
export async function createSessionToken(): Promise<string> {
  const { authSecret, appPasswordHash } = getAuthConfig();
  const pv = await computePasswordVersion(appPasswordHash);

  return new SignJWT({ pv })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(getSecretKey(authSecret));
}

/**
 * Vérifie un JWT de session : signature valide, non expiré, ET `pv`
 * correspondant au hash de mot de passe ACTUELLEMENT en vigueur. Un cookie
 * signé avec le bon secret mais portant un `pv` obsolète (parce
 * qu'`APP_PASSWORD_HASH` a changé depuis) est rejeté : c'est le mécanisme
 * de révocation globale des sessions au changement de mot de passe.
 *
 * Ne catch PAS `AuthConfigError` : une configuration serveur invalide doit
 * remonter comme une erreur explicite à l'appelant (middleware, route de
 * login), pas se travestir en simple session invalide.
 */
export async function verifySessionToken(
  token: string | undefined | null,
): Promise<boolean> {
  // Valider la config AVANT le court-circuit "pas de token" : une
  // configuration serveur invalide doit être détectée dès la première
  // requête, y compris un visiteur anonyme sans cookie — pas seulement au
  // moment d'un login. C'est ce qui permet au middleware de la signaler
  // explicitement plutôt que de rediriger silencieusement vers /login.
  const { authSecret, appPasswordHash } = getAuthConfig();

  if (!token) return false;

  try {
    const { payload } = await jwtVerify(token, getSecretKey(authSecret), {
      algorithms: [ALG],
      // Un token sans `exp` (ou sans `iat`, sur lequel `maxTokenAge`
      // s'appuie) n'est pas exploitable sans déjà posséder `AUTH_SECRET` —
      // mais autant fermer la classe de bug explicitement plutôt que de
      // compter implicitement sur le fait qu'on en émet toujours un.
      requiredClaims: ["exp", "iat"],
      maxTokenAge: `${MAX_AGE_SECONDS}s`,
    });
    const currentPv = await computePasswordVersion(appPasswordHash);
    return typeof payload.pv === "string" && payload.pv === currentPv;
  } catch (error) {
    if (error instanceof AuthConfigError) throw error;
    // Signature invalide, token malformé, expiré, etc. : session invalide.
    return false;
  }
}
