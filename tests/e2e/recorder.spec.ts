import { expect, test } from "@playwright/test";

import { login } from "./helpers/auth";
import { readDbSnapshot, resetAppState } from "./helpers/db";
import { installFakeMicrophone } from "./helpers/fakeMic";
import { installWakeLock } from "./helpers/wakeLock";

/**
 * Tests e2e de la capture audio (ticket P2-5). Voir `tests/e2e/README.md`
 * pour la matrice de couverture par projet Playwright et l'explication du
 * choix technique de simulation du micro (pas de `--use-fake-device-for-*`,
 * voir `helpers/fakeMic.ts`).
 *
 * `MediaRecorder` est totalement absent de WebKit dans cet environnement
 * (vérifié) : aucun test de capture réelle n'y est exécuté, uniquement
 * l'affichage de l'écran (premier bloc ci-dessous).
 */

const RECORD_BUTTON = /^enregistrer$/i;
const STOP_BUTTON = /arrêter l'enregistrement/i;
const PAUSE_BUTTON = /mettre en pause/i;
const RESUME_BUTTON = /reprendre l'enregistrement/i;
const TIMER_TEXT = /^\d{1,2}:\d{2}(:\d{2})?$/;

test.describe("Écran d'enregistrement — affichage (3 projets)", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await resetAppState(page);
  });

  test("la page connectée affiche l'écran d'enregistrement avec un bouton accessible", async ({
    page,
  }) => {
    await expect(page.getByRole("heading", { name: "VoxNote" })).toBeVisible();

    const recordButton = page.getByRole("button", { name: RECORD_BUTTON });
    await expect(recordButton).toBeVisible();
    await expect(recordButton).toBeEnabled();
    await expect(page.getByText("00:00")).toBeVisible();
  });
});

test.describe("Capture réelle (micro simulé — chromium seulement)", () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "WebKit : MediaRecorder est absent de ce build (vérifié), aucun flux réel n'y est capturable. Voir tests/e2e/README.md.",
    );
    await installFakeMicrophone(page);
    await login(page);
    await resetAppState(page);
  });

  test("démarrer un enregistrement change le nom du bouton et démarre le compteur", async ({
    page,
  }) => {
    const timer = page.getByText(TIMER_TEXT);
    await expect(timer).toHaveText("00:00");

    await page.getByRole("button", { name: RECORD_BUTTON }).click();

    await expect(page.getByRole("button", { name: STOP_BUTTON })).toBeVisible();
    await expect(page.getByRole("button", { name: PAUSE_BUTTON })).toBeVisible();
    // Le compteur doit démarrer — temps réel légitime (pas une attente
    // d'état), le tick visuel de TimerDisplay est piloté par setInterval.
    await expect(timer).not.toHaveText("00:00", { timeout: 5000 });
  });

  test("pause puis reprise fige le compteur puis repart, sans compter le temps de pause", async ({
    page,
  }) => {
    const timer = page.getByText(TIMER_TEXT);

    await page.getByRole("button", { name: RECORD_BUTTON }).click();
    await page.waitForTimeout(1200); // laisse tourner un premier segment réel

    await page.getByRole("button", { name: PAUSE_BUTTON }).click();
    await expect(page.getByRole("button", { name: RESUME_BUTTON })).toBeVisible();

    const frozenAt = await timer.textContent();
    expect(frozenAt).not.toBe("00:00");

    // Attente réelle volontaire : on vérifie une ABSENCE de changement sur
    // une durée murale, ce qui n'est pas exprimable par une assertion
    // d'état (il n'y a pas d'état cible à atteindre).
    await page.waitForTimeout(2000);
    await expect(timer).toHaveText(frozenAt ?? "");

    await page.getByRole("button", { name: RESUME_BUTTON }).click();
    await expect(page.getByRole("button", { name: PAUSE_BUTTON })).toBeVisible();
    await page.waitForTimeout(1200); // second segment réel après reprise

    await page.getByRole("button", { name: STOP_BUTTON }).click();
    await expect(page.getByRole("button", { name: RECORD_BUTTON })).toBeVisible();

    // Preuve au niveau base, pas seulement visuelle : si les 2 s de pause
    // avaient été comptées, la durée cumulée dépasserait largement cette
    // borne (≈ 1,2 s + 2 s + 1,2 s ≈ 4,4 s au lieu de ≈ 2,4 s attendus).
    const snapshot = await readDbSnapshot(page);
    expect(snapshot.notes).toHaveLength(1);
    expect(snapshot.segments.length).toBeGreaterThanOrEqual(2);
    const totalDurationMs = snapshot.segments.reduce((sum, s) => sum + s.durationMs, 0);
    expect(snapshot.notes[0]?.durationMs).toBe(totalDurationMs);
    expect(totalDurationMs).toBeGreaterThan(500);
    expect(totalDurationMs).toBeLessThan(3600);
  });

  test("arrêter un enregistrement persiste une note avec au moins un segment en IndexedDB", async ({
    page,
  }) => {
    await page.getByRole("button", { name: RECORD_BUTTON }).click();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: STOP_BUTTON }).click();
    await expect(page.getByRole("button", { name: RECORD_BUTTON })).toBeVisible();

    const snapshot = await readDbSnapshot(page);
    expect(snapshot.notes).toHaveLength(1);
    expect(snapshot.segments).toHaveLength(1);

    const [segment] = snapshot.segments;
    expect(segment).toBeDefined();
    expect(segment?.seq).toBe(0);
    expect(segment?.noteId).toBe(snapshot.notes[0]?.id);
    expect(segment?.size).toBeGreaterThan(0);
    expect(segment?.durationMs).toBeGreaterThan(0);
  });

  test("un enregistrement de 2 secondes crée une note sans crash ni segment vide", async ({
    page,
  }) => {
    await page.getByRole("button", { name: RECORD_BUTTON }).click();
    await page.waitForTimeout(2000);
    await page.getByRole("button", { name: STOP_BUTTON }).click();

    // Retour propre à l'état repos : pas de bandeau d'erreur, bouton réactivé.
    const recordButton = page.getByRole("button", { name: RECORD_BUTTON });
    await expect(recordButton).toBeVisible();
    await expect(recordButton).toBeEnabled();
    // Next.js pose son propre `role="alert"` invisible pour l'annonce de
    // route (`__next-route-announcer__`) : on ne cible que le bandeau
    // d'erreur applicatif (`ErrorBanner`), qui commence toujours par « Erreur : ».
    await expect(page.getByRole("alert").filter({ hasText: "Erreur" })).toHaveCount(0);

    const snapshot = await readDbSnapshot(page);
    expect(snapshot.notes).toHaveLength(1);
    expect(snapshot.segments.length).toBeGreaterThanOrEqual(1);
    for (const segment of snapshot.segments) {
      expect(segment.size).toBeGreaterThan(0);
      expect(segment.durationMs).toBeGreaterThan(0);
    }
  });

  test("refresh en cours d'enregistrement conserve les segments fermés, affiche le bandeau de reprise, et reprendre continue la même note", async ({
    page,
  }) => {
    // Étape 1 : un premier segment fermé (pause), puis reprise et nouveau
    // segment volontairement laissé OUVERT au moment du refresh.
    await page.getByRole("button", { name: RECORD_BUTTON }).click();
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: PAUSE_BUTTON }).click(); // ferme le segment seq=0
    await expect(page.getByRole("button", { name: RESUME_BUTTON })).toBeVisible();

    const beforeReload = await readDbSnapshot(page);
    expect(beforeReload.notes).toHaveLength(1);
    expect(beforeReload.segments).toHaveLength(1);
    const noteId = beforeReload.notes[0]?.id;

    await page.getByRole("button", { name: RESUME_BUTTON }).click(); // rouvre un cycle (seq=1, pas encore fermé)
    await expect(page.getByRole("button", { name: PAUSE_BUTTON })).toBeVisible();
    await page.waitForTimeout(1200); // reste "recording" — seq=1 encore ouvert au moment du refresh

    // --- Critère central : refresh en cours d'enregistrement ---
    await page.reload();

    // Le segment encore ouvert au moment du refresh (seq=1) est perdu — comportement
    // documenté (« un crash ne coûte au pire que le segment en cours ») —
    // mais le segment déjà fermé avant le refresh (seq=0) doit être toujours là.
    const afterReload = await readDbSnapshot(page);
    expect(afterReload.notes).toHaveLength(1);
    expect(afterReload.notes[0]?.id).toBe(noteId);
    expect(afterReload.segments.some((s) => s.seq === 0)).toBe(true);

    const resumeNotice = page.getByRole("status").filter({ hasText: /non terminé/i });
    await expect(resumeNotice).toBeVisible();
    const resumeFromNotice = page.getByRole("button", { name: RESUME_BUTTON });
    await expect(resumeFromNotice).toBeVisible();

    // --- Reprise réelle : continue LA MÊME note, la numérotation ne repart pas à 0 ---
    await resumeFromNotice.click();
    await expect(page.getByRole("button", { name: PAUSE_BUTTON })).toBeVisible();
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: STOP_BUTTON }).click();
    await expect(page.getByRole("button", { name: RECORD_BUTTON })).toBeVisible();

    const final = await readDbSnapshot(page);
    expect(final.notes).toHaveLength(1); // pas de nouvelle note créée
    expect(final.notes[0]?.id).toBe(noteId);
    const seqs = final.segments.map((s) => s.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([0, 1]); // continue à 1, ne repart pas à 0
  });
});

test.describe("Permission microphone refusée (chromium seulement)", () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "WebKit : le rejet se produit avant même la demande de permission (MediaRecorder absent → « no-supported-mime-type »), voir tests/e2e/README.md.",
    );
    await installFakeMicrophone(page, "denied");
    await login(page);
    await resetAppState(page);
  });

  test("affiche un message d'erreur français avec un conseil, en role=alert", async ({ page }) => {
    await page.getByRole("button", { name: RECORD_BUTTON }).click();

    // Next.js pose son propre `role="alert"` invisible pour l'annonce de
    // route (`__next-route-announcer__`) : on ne cible que le bandeau
    // d'erreur applicatif (`ErrorBanner`), qui commence toujours par « Erreur : ».
    const alert = page.getByRole("alert").filter({ hasText: "Erreur" });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("Accès au microphone refusé");
    await expect(alert).toContainText(/autorise le micro/i);

    // L'échec ne bloque pas l'écran : on peut réessayer.
    await expect(page.getByRole("button", { name: RECORD_BUTTON })).toBeVisible();
    await expect(page.getByRole("button", { name: "Réessayer" })).toBeVisible();
  });
});

test.describe("Bandeau wake lock (chromium seulement, nécessite une session active)", () => {
  test.beforeEach(async ({ browserName }) => {
    test.skip(
      browserName !== "chromium",
      "Nécessite un enregistrement démarré avec succès, donc un micro simulé fonctionnel (chromium seulement).",
    );
  });

  test("apparaît quand l'API Wake Lock est absente", async ({ page }) => {
    await installFakeMicrophone(page);
    await installWakeLock(page, "absent");
    await login(page);
    await resetAppState(page);

    await page.getByRole("button", { name: RECORD_BUTTON }).click();
    await expect(page.getByRole("button", { name: STOP_BUTTON })).toBeVisible();

    const banner = page.getByRole("status").filter({ hasText: /garde l'écran allumé/i });
    await expect(banner).toBeVisible();
  });

  test("n'apparaît pas quand l'API Wake Lock est présente et fonctionnelle", async ({ page }) => {
    await installFakeMicrophone(page);
    await installWakeLock(page, "working");
    await login(page);
    await resetAppState(page);

    await page.getByRole("button", { name: RECORD_BUTTON }).click();
    await expect(page.getByRole("button", { name: STOP_BUTTON })).toBeVisible();

    await expect(page.getByText(/garde l'écran allumé/i)).toHaveCount(0);
  });
});
