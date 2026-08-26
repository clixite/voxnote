// Génère le hash bcrypt à mettre dans APP_PASSWORD_HASH.
//
// Usage : pnpm hash-password
//
// La phrase de passe est saisie au clavier en saisie masquée (aucun
// caractère affiché, pas même des astérisques) : elle ne doit JAMAIS
// apparaître en argument de ligne de commande (elle finirait dans
// l'historique du shell) ni être écrite en clair dans un fichier.

import { emitKeypressEvents } from "node:readline";
import bcrypt from "bcryptjs";

const MIN_LENGTH = 12;
const BCRYPT_ROUNDS = 12;

/**
 * Lit une ligne sur stdin sans jamais l'échoir à l'écran, en repassant le
 * terminal en mode "raw" le temps de la saisie. Volontairement sans
 * dépendance à l'API interne `readline._writeToOutput` : on gère nous-mêmes
 * les touches (entrée, retour arrière, Ctrl+C) via `keypress`.
 */
function readMaskedLine(promptText) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(promptText);

    let value = "";

    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("keypress", onKeypress);
    };

    function onKeypress(chunk, key) {
      if (key && key.ctrl && key.name === "c") {
        cleanup();
        stdout.write("\n");
        reject(new Error("Saisie annulée."));
        return;
      }
      if (key && (key.name === "return" || key.name === "enter")) {
        cleanup();
        stdout.write("\n");
        resolve(value);
        return;
      }
      if (key && key.name === "backspace") {
        value = value.slice(0, -1);
        return;
      }
      if (typeof chunk === "string" && chunk.length > 0 && !(key && key.ctrl)) {
        value += chunk;
      }
    }

    stdin.on("keypress", onKeypress);
  });
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error(
      "Ce script doit être exécuté dans un terminal interactif : la saisie masquée requiert un TTY.",
    );
    process.exitCode = 1;
    return;
  }

  const passphrase = await readMaskedLine("Phrase de passe (saisie masquée) : ");

  if (passphrase.length < MIN_LENGTH) {
    console.error(
      `\nPhrase de passe trop courte (${passphrase.length} caractère(s), ${MIN_LENGTH} minimum).\n` +
        "C'est le vrai frein contre le bruteforce : bcrypt ralentit chaque tentative (~100 ms), " +
        "mais seule une phrase assez longue rend l'essai systématique réellement coûteux pour un attaquant. " +
        "Choisis plutôt une phrase de plusieurs mots.",
    );
    process.exitCode = 1;
    return;
  }

  const hash = bcrypt.hashSync(passphrase, BCRYPT_ROUNDS);

  console.log("\nHash bcrypt (à copier dans la variable APP_PASSWORD_HASH sur Vercel) :\n");
  console.log(hash);
  console.log(
    "\nRappel : ce hash n'est pas un secret aussi sensible que le mot de passe en clair, " +
      "mais il ne doit pas non plus être commité dans le dépôt — seule la variable d'environnement le porte.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
