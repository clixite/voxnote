/**
 * Empreinte courte ("pv" = password version) du hash de mot de passe en
 * vigueur.
 *
 * Calculée avec l'API Web Crypto (`crypto.subtle`), disponible à la fois en
 * runtime Node.js (routes API) et en runtime Edge (middleware) — c'est la
 * seule primitive cryptographique dont les deux runtimes disposent
 * nativement, ce qui permet au middleware de vérifier le `pv` d'un token
 * sans jamais appeler bcryptjs (indisponible en edge, et de toute façon bien
 * trop lent pour tourner sur chaque requête).
 *
 * Le `pv` n'est PAS un secret : c'est un simple sélecteur de version dérivé
 * du hash. Il sert uniquement à détecter qu'`APP_PASSWORD_HASH` a changé,
 * pour invalider les sessions émises avec l'ancien hash.
 */
export async function computePasswordVersion(
  passwordHash: string,
): Promise<string> {
  const data = new TextEncoder().encode(passwordHash);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 16);
}
