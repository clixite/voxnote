import type { Page } from "@playwright/test";

export type FakeMicrophoneMode = "working" | "denied";

/**
 * Simule le microphone en remplaçant `navigator.mediaDevices.getUserMedia`,
 * injecté via `page.addInitScript` : s'applique donc avant tout script de
 * l'application, sur chaque navigation dans cette page (rechargement inclus
 * — indispensable pour les scénarios de refresh en cours d'enregistrement).
 *
 * Choix délibéré plutôt que `--use-fake-device-for-media-stream` /
 * `--use-fake-ui-for-media-stream` (`launchOptions.args`, suggérés par le
 * ticket) : ces indicateurs sont spécifiques à Chromium. `launchOptions` se
 * fixe au niveau du fichier de test (`test.use`), pas du projet — un fichier
 * qui les définit s'appliquerait donc aussi au lancement de WebKit quand ce
 * même fichier tourne sous le projet `webkit-mobile`. Vérifié directement
 * (`webkit.launch({ args: [...] })`) : WebKit refuse de démarrer avec une
 * option qu'il ne reconnaît pas (« Cannot parse arguments: Unknown option
 * --use-fake-device-for-media-stream »), ce qui casserait tout le projet
 * webkit-mobile pour ce fichier, pas seulement les tests audio.
 *
 * La solution ci-dessous ne touche à aucune option de lancement : elle governe
 * uniquement le contenu de la page, donc sans risque pour WebKit. Sur
 * Chromium, mode `"working"` fournit un vrai flux audio (oscillateur →
 * `MediaStreamAudioDestinationNode`) que `MediaRecorder` peut réellement
 * enregistrer — vérifié : produit des blobs audio non vides. Sur WebKit
 * (build utilisé par cet environnement), `MediaRecorder` est absent du
 * `window` : aucune stratégie de flux ne le rendrait utilisable, voir le
 * README de ce dossier de tests pour le constat détaillé et la matrice de
 * couverture par projet.
 */
export async function installFakeMicrophone(
  page: Page,
  mode: FakeMicrophoneMode = "working",
): Promise<void> {
  await page.addInitScript((initMode: FakeMicrophoneMode) => {
    const fakeGetUserMedia = async (
      constraints: MediaStreamConstraints,
    ): Promise<MediaStream> => {
      if (initMode === "denied") {
        throw new DOMException(
          "Permission denied by test double",
          "NotAllowedError",
        );
      }
      if (!constraints.audio) {
        throw new DOMException(
          "Only audio is faked in tests",
          "NotSupportedError",
        );
      }
      const ctx = new AudioContext();
      const destination = ctx.createMediaStreamDestination();
      const oscillator = ctx.createOscillator();
      oscillator.frequency.value = 440;
      oscillator.connect(destination);
      oscillator.start();
      return destination.stream;
    };

    const mediaDevices: MediaDevices =
      navigator.mediaDevices ?? ({} as MediaDevices);
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", {
        value: mediaDevices,
        configurable: true,
      });
    }
    Object.defineProperty(mediaDevices, "getUserMedia", {
      value: fakeGetUserMedia,
      configurable: true,
      writable: true,
    });
  }, mode);
}
