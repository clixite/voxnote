import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium-mobile",
      use: { ...devices["Pixel 5"] },
    },
    {
      name: "webkit-mobile",
      use: { ...devices["iPhone 13"] },
    },
  ],
  webServer: {
    command: "pnpm build && pnpm start",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      PORT: String(PORT),
      // Valeurs de test PUBLIQUES (committées volontairement) : le mot de
      // passe en clair correspondant est `phrase-de-passe-de-test-voxnote`,
      // utilisé par les e2e de connexion. Aucune valeur réelle ici.
      AUTH_SECRET:
        process.env.AUTH_SECRET ??
        "voxnote-public-ci-test-secret-do-not-use-in-prod",
      APP_PASSWORD_HASH:
        process.env.APP_PASSWORD_HASH ??
        "$2b$10$UTeiF0JzNamfFO7B6k4ENeL6CTnKPPOJ4OiZKrjictv.0IDUmt6Yq",
      // Le serveur e2e tourne en HTTP simple sur 127.0.0.1 (pas de TLS) :
      // sans ça, le cookie de session partirait avec l'attribut `Secure`
      // (comportement par défaut, voir src/lib/auth/session.ts), que WebKit
      // — contrairement à Chromium — refuse de stocker hors HTTPS. Ne JAMAIS
      // définir cette variable en production.
      ALLOW_INSECURE_COOKIES: "1",
    },
  },
});
