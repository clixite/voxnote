import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers/auth";
import {
  apiError,
  installBlobPipelineMocks,
  type BlobPipelineMock,
} from "./helpers/blobMock";
import { readDbSnapshot, resetAppState, type DbSnapshot } from "./helpers/db";
import { installFakeMicrophone } from "./helpers/fakeMic";

/**
 * Tests e2e du pipeline de transcription (ticket P3-7). Voir le rapport de
 * ticket pour le détail de ce qui est prouvé contre le vrai serveur et ce qui
 * l'est contre une interception réseau (`page.route`).
 *
 * RÉSUMÉ DE LA CONTRAINTE MAJEURE (voir aussi `helpers/blobMock.ts`) : cet
 * environnement n'a ni token Vercel Blob (`BLOB_READ_WRITE_TOKEN`) ni clé de
 * transcription réelle. Toute la CHAÎNE (segment → jeton → upload Blob →
 * transcription → assemblage) est donc testée avec les trois routes
 * concernées interceptées côté navigateur — c'est le vrai client
 * (`@vercel/blob/client`, `fetch`, la file `UploadQueue`, IndexedDB) qui
 * tourne, face à un serveur simulé. Seule la section « Routes protégées »
 * en fin de fichier appelle le vrai serveur.
 *
 * `MediaRecorder` est absent de WebKit dans cet environnement (voir
 * `tests/e2e/README.md` et `recorder.spec.ts`) : tout scénario qui a besoin
 * d'un enregistrement réel est donc chromium seulement (desktop + mobile).
 * La section « Routes protégées » ne dépend pas du micro et tourne sur les
 * 3 projets.
 */

const RECORD_BUTTON = /^enregistrer$/i;
const STOP_BUTTON = /arrêter l'enregistrement/i;
const PAUSE_BUTTON = /mettre en pause/i;
const RESUME_BUTTON = /reprendre l'enregistrement/i;

async function setUpPipelinePage(page: Page): Promise<BlobPipelineMock> {
  const mock = await installBlobPipelineMocks(page);
  await installFakeMicrophone(page);
  await login(page);
  await resetAppState(page);
  return mock;
}

/** Ferme un segment sans arrêter l'enregistrement (pause immédiatement suivie d'une reprise). */
async function closeOneSegment(page: Page, waitMs = 1200): Promise<void> {
  await page.waitForTimeout(waitMs);
  await page.getByRole("button", { name: PAUSE_BUTTON }).click();
  await expect(page.getByRole("button", { name: RESUME_BUTTON })).toBeVisible();
  await page.getByRole("button", { name: RESUME_BUTTON }).click();
  await expect(page.getByRole("button", { name: PAUSE_BUTTON })).toBeVisible();
}

/**
 * Lit l'état courant depuis IndexedDB — jamais l'UI — pour les scénarios qui
 * traversent une coupure réseau ou un refresh : voir la note du rapport de
 * ticket sur la bannière de progression qui disparaît après le rechargement
 * incident déclenché par la détection hors-ligne intégrée à cette version de
 * Next.js (`node_modules/next/dist/client/components/offline.js`). IndexedDB
 * reste la seule source fiable dans ces cas.
 */
function noteStatusPoller(page: Page): () => Promise<string | undefined> {
  return async () => {
    const snapshot = await readDbSnapshot(page);
    return snapshot.notes[0]?.status;
  };
}

test.describe("Pipeline de transcription — chaîne réelle face à un serveur simulé (chromium seulement)", () => {
  test.beforeEach(({ browserName }) => {
    test.skip(
      browserName !== "chromium",
      "WebKit : MediaRecorder est absent de ce build (vérifié dans recorder.spec.ts), aucun segment réel n'y est capturable.",
    );
  });

  test("chaîne nominale : segments uploadés puis transcrits, texte assemblé dans l'ordre des seq même si /api/transcribe répond dans le désordre", async ({
    page,
  }) => {
    const mock = await setUpPipelinePage(page);
    // La file traite les segments par LOTS, et un lot n'est formé qu'à
    // partir de ce qui est déjà en attente au moment où elle relit le store
    // (voir le commentaire de `runTick` dans `queue.ts`) : un segment seul
    // et déjà en vol n'est jamais rejoint en cours de route par un segment
    // créé après lui, même plus rapide. Pour observer un vrai désordre
    // d'arrivée, il faut donc regarder DEUX segments qui finissent dans le
    // MÊME lot : le jeton du segment 0 est délibérément très lent, ce qui le
    // fait traiter seul en premier pendant que les segments 1 et 2 sont créés
    // et rejoignent ENSEMBLE le lot suivant. Dans ce lot, `/api/transcribe`
    // répond plus vite pour le segment 2 que pour le segment 1 : si
    // l'assemblage suivait l'ordre d'arrivée des réponses plutôt que `seq`,
    // le texte final intervertirait les segments 1 et 2.
    mock.setTokenDelayMs((seq) => (seq === 0 ? 3000 : 50));
    mock.setPutDelayMs(() => 50);
    mock.setTranscribeDelayMs((seq) => [50, 800, 100][seq] ?? 0);

    await page.getByRole("button", { name: RECORD_BUTTON }).click();
    await closeOneSegment(page); // seq 0
    await closeOneSegment(page); // seq 1
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: STOP_BUTTON }).click(); // seq 2

    await expect.poll(noteStatusPoller(page), { timeout: 20_000 }).toBe("done");

    // Preuve que les réponses des segments 1 et 2 sont bien arrivées dans le
    // désordre (sinon ce test ne prouverait rien) : seq 2 doit avoir fini
    // avant seq 1, alors qu'il a été créé après.
    const completionOrder = mock.transcribeCompletionOrderSeqs;
    expect(completionOrder.indexOf(2)).toBeLessThan(completionOrder.indexOf(1));

    const snapshot = await readDbSnapshot(page);
    expect(snapshot.notes).toHaveLength(1);
    expect(snapshot.segments.map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(snapshot.segments.every((s) => s.status === "done")).toBe(true);
    expect(snapshot.notes[0]?.text).toBe(
      "Texte transcrit segment 0\n\nTexte transcrit segment 1\n\nTexte transcrit segment 2",
    );
  });

  test("coupure réseau pendant l'upload puis retour : bandeau rassurant, reprise automatique sans clic, zéro perte ni doublon", async ({
    page,
    context,
  }) => {
    const mock = await setUpPipelinePage(page);

    await page.getByRole("button", { name: RECORD_BUTTON }).click();
    await page.waitForTimeout(1200);

    await context.setOffline(true);
    await page.waitForTimeout(200);
    await page.getByRole("button", { name: STOP_BUTTON }).click();

    // Le segment est fermé et persisté localement, mais rien n'a pu être
    // tenté : le bandeau doit rassurer, pas juste signaler la panne.
    const offlineBanner = page.getByRole("status").filter({ hasText: /pas de connexion internet/i });
    await expect(offlineBanner).toBeVisible();
    await expect(offlineBanner).toContainText(/pas d'inquiétude/i);
    await expect(offlineBanner).toContainText(/reprendront tout seuls/i);

    const whileOffline = await readDbSnapshot(page);
    expect(whileOffline.notes).toHaveLength(1);
    expect(whileOffline.segments).toHaveLength(1);
    expect(whileOffline.segments[0]?.status).not.toBe("done");
    // Preuve qu'aucune tentative n'a été faite pendant la coupure (la file
    // vérifie `isOnline()` avant tout appel réseau, voir queue.ts).
    expect(mock.tokenCallCount).toBe(0);

    // --- Retour réseau : aucun clic à partir d'ici. ---
    await context.setOffline(false);

    await expect.poll(noteStatusPoller(page), { timeout: 20_000 }).toBe("done");

    const after: DbSnapshot = await readDbSnapshot(page);
    expect(after.notes).toHaveLength(1); // pas de note dupliquée
    expect(after.segments).toHaveLength(1); // pas de segment dupliqué
    expect(after.segments[0]?.status).toBe("done");
    expect(after.notes[0]?.text).toBe("Texte transcrit segment 0");
  });

  test("erreur non réessayable (retryable: false) : échec immédiat sans nouvel essai, message français, Réessayer fonctionnel", async ({
    page,
  }) => {
    const mock = await setUpPipelinePage(page);
    const FRENCH_MESSAGE = "Cet audio est illisible par le service de transcription.";
    mock.setTranscribeHandler(() => ({
      ok: false,
      status: 422,
      body: apiError(FRENCH_MESSAGE, false),
    }));

    await page.getByRole("button", { name: RECORD_BUTTON }).click();
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: STOP_BUTTON }).click();

    const progress = page.getByTestId("upload-progress");
    await expect(progress).toContainText(FRENCH_MESSAGE, { timeout: 10_000 });
    const retryButton = progress.getByRole("button", { name: "Réessayer" });
    await expect(retryButton).toBeVisible();
    await expect(progress).toContainText("Passage 1 :");

    // Laisse passer du temps : un échec non-retryable ne doit JAMAIS
    // déclencher de nouvel essai tout seul.
    await page.waitForTimeout(3000);
    expect(mock.transcribeCallCount).toBe(1);

    const errored = await readDbSnapshot(page);
    expect(errored.segments[0]?.status).toBe("error");
    expect(errored.segments[0]?.error).toBe(FRENCH_MESSAGE);

    // Le bouton Réessayer doit fonctionner : reconfigure un succès puis clique.
    mock.setTranscribeHandler(() => ({ ok: true, text: "Texte après réessai" }));
    await retryButton.click();

    await expect.poll(noteStatusPoller(page), { timeout: 10_000 }).toBe("done");
    expect(mock.transcribeCallCount).toBe(2);
  });

  test("erreur réessayable (retryable: true) : deux échecs puis un succès, sans intervention", async ({ page }) => {
    const mock = await setUpPipelinePage(page);
    mock.setTranscribeHandler((info) => {
      if (info.attempt < 3) {
        return { ok: false, status: 503, body: apiError("Le service de transcription est momentanément indisponible.", true) };
      }
      return { ok: true, text: "Texte au troisième essai" };
    });

    await page.getByRole("button", { name: RECORD_BUTTON }).click();
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: STOP_BUTTON }).click();

    // Backoff exponentiel (2s puis 4s, voir backoff.ts) : le troisième essai
    // arrive automatiquement, sans le moindre clic ici.
    await expect.poll(noteStatusPoller(page), { timeout: 20_000 }).toBe("done");

    expect(mock.transcribeCallCount).toBe(3);
    const snapshot = await readDbSnapshot(page);
    expect(snapshot.segments[0]?.status).toBe("done");
    expect(snapshot.notes[0]?.text).toBe("Texte au troisième essai");
  });

  test("reprise après refresh : la file se reconstitue depuis IndexedDB (pas un état mémoire)", async ({
    page,
    context,
  }) => {
    const mock = await setUpPipelinePage(page);

    await page.getByRole("button", { name: RECORD_BUTTON }).click();
    await page.waitForTimeout(1200);

    await context.setOffline(true);
    await page.waitForTimeout(200);
    await page.getByRole("button", { name: STOP_BUTTON }).click();
    await page.waitForTimeout(500);

    const beforeReload = await readDbSnapshot(page);
    expect(beforeReload.segments).toHaveLength(1);
    expect(beforeReload.segments[0]?.status).not.toBe("done");
    expect(mock.tokenCallCount).toBe(0);

    // --- Refresh EXPLICITE pendant que le réseau est TOUJOURS coupé. ---
    await page.reload();

    const afterReloadStillOffline = await readDbSnapshot(page);
    expect(afterReloadStillOffline.notes).toHaveLength(1);
    expect(afterReloadStillOffline.segments).toHaveLength(1);
    expect(mock.tokenCallCount).toBe(0); // toujours rien tenté, réseau coupé

    await context.setOffline(false);

    await expect.poll(noteStatusPoller(page), { timeout: 20_000 }).toBe("done");

    const final = await readDbSnapshot(page);
    expect(final.notes).toHaveLength(1);
    expect(final.segments).toHaveLength(1); // pas de doublon créé par la reprise
    expect(final.segments[0]?.status).toBe("done");
  });

  test("pas de ré-upload d'un segment déjà uploadé : la transcription échoue après un upload réussi, la reprise ne redemande pas de jeton", async ({
    page,
  }) => {
    const mock = await setUpPipelinePage(page);
    mock.setTranscribeHandler((info) => {
      if (info.attempt === 1) {
        return { ok: false, status: 503, body: apiError("Panne transitoire du service.", true) };
      }
      return { ok: true, text: "Texte après reprise de la transcription seule" };
    });

    await page.getByRole("button", { name: RECORD_BUTTON }).click();
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: STOP_BUTTON }).click();

    await expect.poll(noteStatusPoller(page), { timeout: 15_000 }).toBe("done");

    // L'upload (jeton + PUT Blob) n'a eu lieu qu'une seule fois, alors que la
    // transcription a été appelée deux fois.
    expect(mock.tokenCallCount).toBe(1);
    expect(mock.blobPutCallCount).toBe(1);
    expect(mock.transcribeCallCount).toBe(2);

    const snapshot = await readDbSnapshot(page);
    expect(snapshot.segments[0]?.blobUrl).toBeTruthy();
  });

  test("concurrence bornée : jamais plus de 3 requêtes simultanées, même avec 4 segments en attente", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    const mock = await setUpPipelinePage(page);
    // Le premier segment est délibérément très lent à obtenir son jeton :
    // le temps qu'il traîne, les 3 autres segments sont créés et deviennent
    // tous les trois prêts en même temps, ce qui force un vrai lot de 3
    // plutôt qu'un traitement fortuitement séquentiel.
    mock.setTokenDelayMs((seq) => (seq === 0 ? 5000 : 150));
    mock.setPutDelayMs(() => 150);
    mock.setTranscribeDelayMs(() => 150);

    await page.getByRole("button", { name: RECORD_BUTTON }).click();
    await closeOneSegment(page); // seq 0
    await closeOneSegment(page); // seq 1
    await closeOneSegment(page); // seq 2
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: STOP_BUTTON }).click(); // seq 3

    await expect.poll(noteStatusPoller(page), { timeout: 30_000 }).toBe("done");

    expect(mock.maxConcurrentRequests).toBeLessThanOrEqual(3);
    // Preuve que le plafond est bien UTILISÉ (vrai parallélisme), pas
    // seulement jamais dépassé par absence de parallélisme.
    expect(mock.maxConcurrentRequests).toBeGreaterThanOrEqual(2);

    const snapshot = await readDbSnapshot(page);
    expect(snapshot.segments).toHaveLength(4);
    expect(snapshot.segments.every((s) => s.status === "done")).toBe(true);
  });

  test("note vide : un segment transcrit en texte vide n'empêche pas la note de passer à « done », sans erreur affichée", async ({
    page,
  }) => {
    const mock = await setUpPipelinePage(page);
    mock.setTranscribeHandler(() => ({ ok: true, text: "" }));

    await page.getByRole("button", { name: RECORD_BUTTON }).click();
    await page.waitForTimeout(2000); // enregistrement très court, cas limite du ticket
    await page.getByRole("button", { name: STOP_BUTTON }).click();

    await expect.poll(noteStatusPoller(page), { timeout: 10_000 }).toBe("done");

    await expect(page.getByRole("alert").filter({ hasText: "Erreur" })).toHaveCount(0);
    const snapshot = await readDbSnapshot(page);
    expect(snapshot.segments[0]?.status).toBe("done");
    expect(snapshot.notes[0]?.text).toBe("");
  });
});

test.describe("Routes protégées et validation d'entrée (3 projets — appels réels au serveur)", () => {
  test("POST /api/blob/upload-token sans session → 401", async ({ request }) => {
    const response = await request.post("/api/blob/upload-token", {
      data: {},
      headers: { "content-type": "application/json" },
    });
    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("UNAUTHENTICATED");
  });

  test("POST /api/transcribe sans session → 401", async ({ request }) => {
    const response = await request.post("/api/transcribe", {
      data: {},
      headers: { "content-type": "application/json" },
    });
    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("UNAUTHENTICATED");
  });

  test("DELETE /api/notes/[noteId] sans session → 401", async ({ request }) => {
    const response = await request.delete("/api/notes/11111111-1111-1111-1111-111111111111");
    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("UNAUTHENTICATED");
  });

  test("GET /api/cron/purge sans CRON_SECRET → 401, et est exclu du middleware alors que /api/cron/autre-chose ne l'est pas", async ({
    request,
  }) => {
    // Chemin protégé par la route elle-même (jamais de cookie envoyé ici) :
    // le message vient de `route.ts`, pas du middleware.
    const purgeResponse = await request.get("/api/cron/purge");
    expect(purgeResponse.status()).toBe(401);
    const purgeBody = await purgeResponse.json();
    expect(purgeBody.message).toBe("Authentification cron invalide.");

    // Un AUTRE chemin sous /api/cron/ n'est PAS exclu : c'est le middleware
    // (message générique de session) qui répond, jamais la route elle-même,
    // preuve que l'exclusion est un chemin exact et non un préfixe.
    const otherResponse = await request.get("/api/cron/autre-chose");
    expect(otherResponse.status()).toBe(401);
    const otherBody = await otherResponse.json();
    expect(otherBody.message).toBe("Session expirée. Reconnecte-toi.");
    expect(otherBody.message).not.toBe(purgeBody.message);
  });

  test.describe("Avec une session valide", () => {
    test.beforeEach(async ({ page }) => {
      await login(page);
    });

    test("POST /api/transcribe : corps invalide → 400, sans dépendre de Vercel Blob", async ({ page }) => {
      const malformed = await page.request.post("/api/transcribe", {
        data: "ceci n'est pas du JSON",
        headers: { "content-type": "application/json" },
      });
      expect(malformed.status()).toBe(400);
      expect((await malformed.json()).error).toBe("BAD_REQUEST");

      const missingFields = await page.request.post("/api/transcribe", {
        data: {},
        headers: { "content-type": "application/json" },
      });
      expect(missingFields.status()).toBe(400);

      const badMimeType = await page.request.post("/api/transcribe", {
        data: {
          noteId: "11111111-1111-1111-1111-111111111111",
          seq: 0,
          blobUrl: "https://example.com/a",
          mimeType: "video/mp4",
          lang: "auto",
        },
        headers: { "content-type": "application/json" },
      });
      expect(badMimeType.status()).toBe(400);
    });

    test("POST /api/transcribe : corps trop volumineux → 413 (le binaire audio ne doit jamais transiter par cette route)", async ({
      page,
    }) => {
      const response = await page.request.post("/api/transcribe", {
        data: { noteId: "a".repeat(9000) },
        headers: { "content-type": "application/json" },
      });
      expect(response.status()).toBe(413);
      const body = await response.json();
      expect(body.error).toBe("PAYLOAD_TOO_LARGE");
    });

    test("DOCUMENTE UNE LIMITE D'ENVIRONNEMENT : POST /api/transcribe ne peut pas prouver le refus d'un blobUrl étranger ici (500, pas 400)", async ({
      page,
    }) => {
      // Ce test documente un comportement RÉEL et VÉRIFIÉ, pas le critère
      // d'acceptation « refuse un blobUrl étranger » lui-même — cette
      // preuve-là est hors de portée dans cet environnement, voir pourquoi :
      //
      // `checkBlobOwnership` (route.ts) appelle `headBlob()`
      // (`@/lib/blob/store`), qui lève `BlobConfigError` faute de
      // `BLOB_READ_WRITE_TOKEN`. Depuis le correctif du BLOQUANT B3
      // (`src/lib/transcription/blob-errors.ts`, du jour de ce ticket),
      // seule une VRAIE absence du blob (`BlobNotFoundError`) est traduite en
      // « lien invalide » (400) ; toute autre erreur — dont `BlobConfigError`
      // — devient un 500 SERVER_MISCONFIGURED. C'est le comportement plus
      // sûr (une panne d'infra n'est plus jamais confondue avec un lien
      // invalide) mais il ferme aussi la porte à toute observation d'un 400
      // dans cet environnement : AUCUN blobUrl, y compris un blobUrl
      // parfaitement légitime, ne peut atteindre le contrôle d'appartenance
      // ici. La preuve complète de l'anti-SSRF (accepter un blobUrl qui nous
      // appartient vraiment, refuser un blobUrl d'une autre note) nécessite
      // un vrai token Blob — hors de portée de cet environnement. Voir le
      // rapport de ticket.
      const response = await page.request.post("/api/transcribe", {
        data: {
          noteId: "11111111-1111-1111-1111-111111111111",
          seq: 0,
          blobUrl: "https://example.com/not-our-blob",
          mimeType: "audio/webm",
          lang: "auto",
        },
        headers: { "content-type": "application/json" },
      });
      expect(response.status()).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("SERVER_MISCONFIGURED");
    });

    test("DELETE /api/notes/[noteId] : identifiant invalide → 400, sans dépendre de Vercel Blob", async ({ page }) => {
      const response = await page.request.delete("/api/notes/pas-un-uuid");
      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("BAD_REQUEST");
      expect(body.message).toBe("Identifiant de note invalide.");
    });

    test("DOCUMENTE UNE LIMITE D'ENVIRONNEMENT : POST /api/blob/upload-token répond 500 quel que soit le payload, faute de BLOB_READ_WRITE_TOKEN", async ({
      page,
    }) => {
      // `generateUploadToken` (src/lib/blob/store.ts) lit la configuration
      // Blob AVANT même d'atteindre `onBeforeGenerateToken` (qui porte notre
      // validation métier : mimeType, taille, forme de noteId/seq). Sans
      // `BLOB_READ_WRITE_TOKEN` — absent de cet environnement et de
      // `playwright.config.ts` — CETTE ROUTE NE PEUT PAS être testée pour son
      // critère d'acceptation « payload invalide → 400 » : elle répond
      // systématiquement 500 SERVER_MISCONFIGURED, y compris pour un payload
      // parfaitement valide. Ce test documente ce fait vérifié (voir le
      // rapport de ticket) plutôt que de laisser croire que la validation
      // d'entrée de cette route est prouvée par la suite e2e.
      const response = await page.request.post("/api/blob/upload-token", {
        data: {},
        headers: { "content-type": "application/json" },
      });
      expect(response.status()).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("SERVER_MISCONFIGURED");
      expect(body.message).toContain("BLOB_READ_WRITE_TOKEN");
    });
  });
});
