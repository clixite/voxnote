// @vitest-environment node
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";

import { verifyPassword } from "./password";

describe("verifyPassword", () => {
  const passphrase = "phrase-de-passe-de-test-voxnote";
  // Coût faible : ces tests n'ont pas besoin de la lenteur réelle de bcrypt.
  const hash = bcrypt.hashSync(passphrase, 4);

  it("renvoie true pour le bon mot de passe", async () => {
    expect(await verifyPassword(passphrase, hash)).toBe(true);
  });

  it("renvoie false pour un mauvais mot de passe", async () => {
    expect(await verifyPassword("mauvais-mot-de-passe", hash)).toBe(false);
  });

  it("renvoie false (et ne lève pas) pour un hash malformé", async () => {
    await expect(
      verifyPassword(passphrase, "pas-un-hash-bcrypt-valide"),
    ).resolves.toBe(false);
  });

  it("renvoie false (et ne lève pas) pour un hash vide", async () => {
    await expect(verifyPassword(passphrase, "")).resolves.toBe(false);
  });
});
