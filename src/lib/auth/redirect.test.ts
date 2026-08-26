// @vitest-environment node
import { describe, expect, it } from "vitest";

import { sanitizeRedirectPath } from "./redirect";

const LOGIN_BASE = "https://voxnote.app/login";
const SAFE_ORIGIN = "https://voxnote.app";

/**
 * Vérifie sur la chaîne que le navigateur verra réellement, pas seulement
 * par comparaison textuelle : on résout `sanitizeRedirectPath(candidate)`
 * comme le ferait `new URL(from, location)` côté client, et on vérifie que
 * l'origine obtenue reste bien celle de l'application.
 */
function resolvesToSameOrigin(candidate: string | null | undefined): boolean {
  const sanitized = sanitizeRedirectPath(candidate);
  const resolved = new URL(sanitized, LOGIN_BASE);
  return resolved.origin === SAFE_ORIGIN;
}

const TAB = "\t";
const LF = "\n";
const CR = "\r";
const NUL = "\x00";

describe("sanitizeRedirectPath", () => {
  it("laisse passer un chemin interne normal", () => {
    expect(sanitizeRedirectPath("/note/123")).toBe("/note/123");
  });

  it("laisse passer la racine", () => {
    expect(sanitizeRedirectPath("/")).toBe("/");
  });

  it("retombe sur / pour null", () => {
    expect(sanitizeRedirectPath(null)).toBe("/");
  });

  it("retombe sur / pour undefined", () => {
    expect(sanitizeRedirectPath(undefined)).toBe("/");
  });

  it("retombe sur / pour une chaîne vide", () => {
    expect(sanitizeRedirectPath("")).toBe("/");
  });

  it("rejette une URL absolue externe", () => {
    expect(sanitizeRedirectPath("https://evil.com")).toBe("/");
  });

  it("rejette un chemin ne commençant pas par /", () => {
    expect(sanitizeRedirectPath("evil.com")).toBe("/");
  });

  it("rejette // (redirection ouverte relative au protocole)", () => {
    expect(sanitizeRedirectPath("//evil.com")).toBe("/");
  });

  it("rejette //evil.com/path", () => {
    expect(sanitizeRedirectPath("//evil.com/path")).toBe("/");
  });

  it("rejette /\\evil.com (contournement navigateur connu)", () => {
    expect(sanitizeRedirectPath("/\\evil.com")).toBe("/");
  });

  describe("bypass par caractères de contrôle (tabulation / saut de ligne / retour chariot)", () => {
    // L'URL Standard (WHATWG) retire \t \n \r n'importe où dans la chaîne
    // AVANT de parser : sans normalisation préalable, ces entrées
    // redeviennent "//evil.com" une fois passées à `new URL(...)`.
    const cases: Array<[string, string]> = [
      [`/${TAB}/evil.com`, "tabulation"],
      [`/${LF}/evil.com`, "saut de ligne"],
      [`/${CR}/evil.com`, "retour chariot"],
      [`/${TAB}${TAB}//evil.com`, "tabulations multiples devant //"],
    ];

    it.each(cases)("rejette %j (%s)", (candidate) => {
      expect(sanitizeRedirectPath(candidate)).toBe("/");
    });

    const allMalicious = [
      ...cases.map(([candidate]) => candidate),
      "//evil.com",
      "/\\evil.com",
      "https://evil.com",
    ];

    it.each(allMalicious)(
      "new URL(sanitizeRedirectPath(%j), base) reste sur l'origine de l'app",
      (candidate) => {
        expect(resolvesToSameOrigin(candidate)).toBe(true);
      },
    );

    it("rejette un autre caractère de contrôle (NUL) qui survit au retrait de \\t\\n\\r", () => {
      expect(sanitizeRedirectPath(`/${NUL}/evil.com`)).toBe("/");
    });
  });

  it.each(["/note/123", "/", "/notes?tri=recent"])(
    "un chemin interne légitime (%j) résout bien sur l'origine de l'app",
    (candidate) => {
      expect(resolvesToSameOrigin(candidate)).toBe(true);
    },
  );
});
