import { expect, test } from "@playwright/test";

import { login } from "./helpers/auth";

// La page d'accueil est protégée depuis P1B-2 : ce test se connecte
// d'abord (voir tests/e2e/helpers/auth.ts). Le comportement de la
// protection elle-même (redirections, session, cookie forgé, etc.) est
// couvert par tests/e2e/auth.spec.ts.
test("la page d'accueil s'affiche et contient VoxNote", async ({ page }) => {
  await login(page);

  await expect(page).toHaveTitle(/VoxNote/);
  await expect(
    page.getByRole("heading", { name: "VoxNote" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /enregistrer/i }),
  ).toBeDisabled();
});
