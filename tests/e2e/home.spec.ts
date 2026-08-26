import { expect, test } from "@playwright/test";

test("la page d'accueil s'affiche et contient VoxNote", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/VoxNote/);
  await expect(
    page.getByRole("heading", { name: "VoxNote" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /enregistrer/i }),
  ).toBeDisabled();
});
