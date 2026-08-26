// @vitest-environment node
import { describe, expect, it } from "vitest";

import { sanitizeRedirectPath } from "./redirect";

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
});
