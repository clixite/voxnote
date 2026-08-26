// @vitest-environment node
import { describe, expect, it } from "vitest";

import { computePasswordVersion } from "./pv";

describe("computePasswordVersion", () => {
  it("produit une empreinte hexadécimale de 16 caractères", async () => {
    const pv = await computePasswordVersion("$2b$10$somehash");
    expect(pv).toMatch(/^[0-9a-f]{16}$/);
  });

  it("est déterministe pour un même hash", async () => {
    const a = await computePasswordVersion("$2b$10$somehash");
    const b = await computePasswordVersion("$2b$10$somehash");
    expect(a).toBe(b);
  });

  it("diffère pour deux hash différents (détecte un changement de mot de passe)", async () => {
    const a = await computePasswordVersion("$2b$10$oldhash");
    const b = await computePasswordVersion("$2b$10$newhash");
    expect(a).not.toBe(b);
  });
});
