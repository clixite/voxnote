import { expect, type Page } from "@playwright/test";

/**
 * Mot de passe de test en clair, correspondant au hash bcrypt câblé dans
 * `APP_PASSWORD_HASH` par `playwright.config.ts` (voir aussi
 * `docs/ENVIRONNEMENT.md`). Valeur de test publique, committée
 * volontairement — ce n'est pas un secret.
 */
export const TEST_PASSWORD = "phrase-de-passe-de-test-voxnote";

/** Mot de passe volontairement faux, pour les scénarios d'échec. */
export const WRONG_PASSWORD = "ce-mot-de-passe-est-volontairement-faux";

/**
 * Remplit le champ mot de passe et soumet le formulaire, sans présumer du
 * résultat : à l'appelant de vérifier le succès (nouvelle page) ou l'échec
 * (message d'erreur affiché).
 */
export async function submitLoginForm(
  page: Page,
  password: string,
): Promise<void> {
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
}

/**
 * Connexion complète avec le bon mot de passe : va sur `/login` (avec un
 * éventuel paramètre `from`), soumet le formulaire, et attend la sortie de
 * `/login` comme preuve de succès.
 *
 * Helper central, pensé pour être réutilisé par toutes les phases
 * suivantes qui ont simplement besoin d'une session active avant de
 * démarrer leur propre scénario — ces tests-là n'ont pas besoin de
 * connaître l'URL de destination exacte, seulement d'être connectés.
 *
 * Les tests qui vérifient eux-mêmes la mécanique de redirection (page
 * demandée initialement, protection anti-open-redirect) n'utilisent pas ce
 * helper : ils appellent `submitLoginForm` directement pour garder le
 * contrôle sur l'assertion de l'URL finale.
 */
export async function login(
  page: Page,
  options: { from?: string; password?: string } = {},
): Promise<void> {
  const loginPath = options.from
    ? `/login?from=${encodeURIComponent(options.from)}`
    : "/login";
  await page.goto(loginPath);
  await submitLoginForm(page, options.password ?? TEST_PASSWORD);
  await expect(page).not.toHaveURL(/\/login(\?|$)/);
}
