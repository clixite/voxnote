import bcrypt from "bcryptjs";

/**
 * Compare un mot de passe en clair à un hash bcrypt.
 *
 * `bcrypt.compare` ne doit jamais lever d'exception non gérée, y compris
 * quand `hash` n'est pas un hash bcrypt valide (variable d'environnement
 * mal renseignée, par exemple) : dans ce cas on renvoie simplement `false`,
 * comme pour un mot de passe incorrect.
 *
 * Réservée au runtime Node.js (bcryptjs est pur JS mais reste coûteux :
 * jamais appelée depuis le middleware edge, voir `pv.ts`).
 */
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}
