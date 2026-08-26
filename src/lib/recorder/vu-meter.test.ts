import { describe, expect, it } from "vitest";

import { computeNormalizedLevel } from "./vu-meter";

describe("computeNormalizedLevel", () => {
  it("renvoie 0 pour un silence parfait (toutes les valeurs à 128)", () => {
    expect(computeNormalizedLevel(new Uint8Array(32).fill(128))).toBe(0);
  });

  it("renvoie 1 pour un signal saturé (alternance 0/255)", () => {
    const data = new Uint8Array(32);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 2 === 0 ? 0 : 255;
    expect(computeNormalizedLevel(data)).toBeCloseTo(1, 1);
  });

  it("renvoie une valeur intermédiaire proportionnelle à l'amplitude", () => {
    const low = computeNormalizedLevel(new Uint8Array(32).fill(148)); // +20
    const high = computeNormalizedLevel(new Uint8Array(32).fill(208)); // +80
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);
  });

  it("ne dépasse jamais 1 même avec un buffer artificiel hors bornes", () => {
    expect(computeNormalizedLevel(new Uint8Array(4).fill(255))).toBeLessThanOrEqual(1);
  });

  it("gère un buffer vide sans lever", () => {
    expect(computeNormalizedLevel(new Uint8Array(0))).toBe(0);
  });
});
