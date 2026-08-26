import { expect, test } from "@playwright/test";

import { login } from "./helpers/auth";

// La page d'accueil est protégée depuis P1B-2 : ce test se connecte
// d'abord (voir tests/e2e/helpers/auth.ts). Le comportement de la
// protection elle-même (redirections, session, cookie forgé, etc.) est
// couvert par tests/e2e/auth.spec.ts. Depuis P2-4, la page d'accueil est
// l'écran d'enregistrement : son comportement détaillé (démarrage, pause,
// reprise, persistance, refresh, permission refusée, wake lock) est couvert
// par tests/e2e/recorder.spec.ts. Ce test-ci ne vérifie que l'affichage
// minimal attendu au premier chargement.
test("la page d'accueil s'affiche et propose l'enregistrement", async ({ page }) => {
  await login(page);

  await expect(page).toHaveTitle(/VoxNote/);
  await expect(
    page.getByRole("heading", { name: "VoxNote" }),
  ).toBeVisible();

  const recordButton = page.getByRole("button", { name: /enregistrer/i });
  await expect(recordButton).toBeVisible();
  await expect(recordButton).toBeEnabled();
});
