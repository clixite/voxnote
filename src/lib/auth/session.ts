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

function baseCookieOptions(): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
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
    });
    const currentPv = await computePasswordVersion(appPasswordHash);
    return typeof payload.pv === "string" && payload.pv === currentPv;
  } catch (error) {
    if (error instanceof AuthConfigError) throw error;
    // Signature invalide, token malformé, expiré, etc. : session invalide.
    return false;
  }
}
