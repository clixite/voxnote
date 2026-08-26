import { expect, test } from "@playwright/test";

import { login, submitLoginForm, TEST_PASSWORD } from "./helpers/auth";

// Chaque test Playwright démarre avec un contexte de navigateur neuf (page
// fixture par test) : aucun cookie ne fuit d'un test à l'autre sans action
// explicite. On ne partage donc jamais `storageState` ici.

test.describe("Visiteur anonyme", () => {
  test("un visiteur sans cookie sur / est redirigé vers /login avec le paramètre from correct", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page).toHaveURL(
      (url) => url.pathname === "/login" && url.searchParams.get("from") === "/",
    );
  });

  test("/confidentialite reste accessible sans connexion", async ({ page }) => {
    const response = await page.goto("/confidentialite");

    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL((url) => url.pathname === "/confidentialite");
    await expect(
      page.getByRole("heading", { name: "Confidentialité" }),
    ).toBeVisible();
  });
});

test.describe("Connexion", () => {
  test("un mauvais mot de passe affiche le message d'erreur et ne donne aucun accès", async ({
    page,
  }) => {
    await page.goto("/login");
    await submitLoginForm(page, "un-mot-de-passe-qui-ne-marche-pas");

    // `getByRole("alert")` seul est ambigu : Next.js App Router injecte son
    // propre `<div role="alert" id="__next-route-announcer__">` (annonceur
    // de route, accessibilité), vide, sur chaque page. Le rôle ARIA "alert"
    // ne tire pas son nom accessible de son contenu (name from: author
    // seulement), donc filtrer par `name` ne fonctionne pas ici : on filtre
    // par texte visible pour cibler uniquement le message d'erreur.
    await expect(
      page.getByRole("alert").filter({ hasText: "Mot de passe incorrect." }),
    ).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === "/login");

    const cookies = await page.context().cookies();
    expect(cookies.some((cookie) => cookie.name === "vox_session")).toBe(false);

    // Aucun accès : une tentative directe sur / doit toujours rediriger.
    await page.goto("/");
    await expect(page).toHaveURL((url) => url.pathname === "/login");
  });

  test("un bon mot de passe donne accès et la session survit à un rechargement complet", async ({
    page,
  }) => {
    await login(page);

    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: "VoxNote" })).toBeVisible();

    // C'est LE test qui prouve que le cookie de session tient : un
    // rechargement complet de la page (nouvelle requête HTTP, pas une
    // navigation client) ne doit pas renvoyer vers /login.
    await page.reload();

    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: "VoxNote" })).toBeVisible();
  });
});

test.describe("Déconnexion", () => {
  test("se déconnecter renvoie vers /login et tue réellement la session côté serveur", async ({
    page,
  }) => {
    await login(page);

    await page.getByRole("button", { name: "Se déconnecter" }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/login");

    // La session doit être vraiment invalidée, pas seulement masquée côté
    // client : une nouvelle tentative d'accès à / doit de nouveau
    // rediriger vers /login (et pas rester silencieusement accessible).
    await page.goto("/");
    await expect(page).toHaveURL(
      (url) => url.pathname === "/login" && url.searchParams.get("from") === "/",
    );
  });
});

test.describe("Cookie falsifié", () => {
  test("un cookie vox_session bricolé à la main est rejeté et redirige vers /login", async ({
    page,
    baseURL,
  }) => {
    await page.context().addCookies([
      {
        name: "vox_session",
        value: "n-importe-quoi",
        url: baseURL,
      },
    ]);

    await page.goto("/");

    await expect(page).toHaveURL((url) => url.pathname === "/login");
  });
});

test.describe("Routes API protégées", () => {
  test("un appel direct à une route protégée sans cookie renvoie 401 JSON avant même un 404", async ({
    request,
  }) => {
    // Aucune route protégée métier n'existe encore à ce stade du backlog
    // (seules /api/auth/login et /api/auth/logout existent, et elles sont
    // explicitement publiques). On appelle donc une route /api/* qui
    // n'existe pas : le comportement attendu et documenté par le middleware
    // est qu'il répond 401 avant que Next.js ait la moindre chance de
    // répondre 404 — une route protégée ne doit pas révéler son existence
    // (ou son inexistence) à un visiteur anonyme.
    const response = await request.post("/api/notes-e2e-inexistante", {
      data: { anything: true },
    });

    expect(response.status()).toBe(401);
    expect(response.headers()["content-type"]).toContain("application/json");

    const body = (await response.json()) as { error?: string; message?: string };
    expect(body.error).toBe("UNAUTHENTICATED");
    expect(typeof body.message).toBe("string");
    expect(body.message?.length).toBeGreaterThan(0);
  });
});

test.describe("Redirection post-connexion", () => {
  test("après connexion, on atterrit sur la page initialement demandée", async ({
    page,
  }) => {
    // Étape 1 : une page publique, accessible sans connexion.
    await page.goto("/confidentialite");
    await expect(
      page.getByRole("heading", { name: "Confidentialité" }),
    ).toBeVisible();

    // Étape 2 : une URL protégée précise (avec un paramètre distinctif, pour
    // vérifier qu'on ne retombe pas simplement sur la destination par
    // défaut "/" mais bien sur l'URL demandée telle quelle).
    const requestedPath = "/?depuis=test-e2e-p1b4";
    await page.goto(requestedPath);
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === "/login" &&
        url.searchParams.get("from") === requestedPath,
    );

    // Étape 3 : connexion, et vérification qu'on atterrit bien sur la page
    // initialement demandée (avec son paramètre de requête préservé).
    await submitLoginForm(page, TEST_PASSWORD);
    await expect(page).toHaveURL(
      (url) => url.pathname === "/" && url.searchParams.get("depuis") === "test-e2e-p1b4",
    );
    await expect(page.getByRole("heading", { name: "VoxNote" })).toBeVisible();
  });
});

test.describe("Protection anti-open-redirect", () => {
  for (const evilFrom of ["//evil.example", "/\\evil.example"]) {
    test(`from=${evilFrom} ne redirige pas hors du domaine après connexion`, async ({
      page,
    }) => {
      await page.goto(`/login?from=${encodeURIComponent(evilFrom)}`);
      await submitLoginForm(page, TEST_PASSWORD);

      // On reste sur le domaine local, avec la page d'accueil comme
      // destination de repli — jamais envoyé vers "evil.example".
      await expect(page).toHaveURL(
        (url) => url.pathname === "/" && !url.href.includes("evil.example"),
      );
      await expect(page.getByRole("heading", { name: "VoxNote" })).toBeVisible();
    });
  }
});
