import { describe, expect, it } from "vitest";

import { MIME_TYPE_CANDIDATES, pickSupportedMimeType } from "./mime-types";

function supporting(...types: string[]) {
  const set = new Set(types);
  return (type: string) => set.has(type);
}

describe("pickSupportedMimeType", () => {
  it("choisit audio/webm;codecs=opus en priorité quand il est supporté", () => {
    const isTypeSupported = supporting(
      "audio/webm;codecs=opus",
      "audio/mp4;codecs=mp4a.40.2",
    );
    expect(pickSupportedMimeType(isTypeSupported)).toBe("audio/webm;codecs=opus");
  });

  it("retombe sur audio/mp4;codecs=mp4a.40.2 sur Safari (pas de webm)", () => {
    const isTypeSupported = supporting("audio/mp4;codecs=mp4a.40.2", "audio/mp4");
    expect(pickSupportedMimeType(isTypeSupported)).toBe("audio/mp4;codecs=mp4a.40.2");
  });

  it("respecte l'ordre de préférence complet, candidat par candidat", () => {
    for (let i = 0; i < MIME_TYPE_CANDIDATES.length; i += 1) {
      const remaining = MIME_TYPE_CANDIDATES.slice(i);
      const isTypeSupported = supporting(...remaining);
      expect(pickSupportedMimeType(isTypeSupported)).toBe(MIME_TYPE_CANDIDATES[i]);
    }
  });

  it("renvoie undefined si aucun candidat n'est supporté", () => {
    expect(pickSupportedMimeType(() => false)).toBeUndefined();
  });

  it("ignore un candidat dont isTypeSupported lève, et continue la recherche", () => {
    const isTypeSupported = (type: string) => {
      if (type === "audio/webm;codecs=opus") throw new Error("boom");
      return type === "audio/mp4";
    };
    expect(pickSupportedMimeType(isTypeSupported)).toBe("audio/mp4");
  });

  it("accepte une liste de candidats personnalisée", () => {
    expect(pickSupportedMimeType(supporting("audio/wav"), ["audio/wav"])).toBe("audio/wav");
  });
});
