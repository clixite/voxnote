import { describe, expect, it } from "vitest";

import {
  computeBackoffDelayMs,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
} from "./backoff";

describe("computeBackoffDelayMs", () => {
  it("renvoie 0 pour une tentative <= 0 (essai immédiat)", () => {
    expect(computeBackoffDelayMs(0)).toBe(0);
    expect(computeBackoffDelayMs(-1)).toBe(0);
  });

  it("double le délai à chaque tentative", () => {
    expect(computeBackoffDelayMs(1)).toBe(DEFAULT_BASE_DELAY_MS);
    expect(computeBackoffDelayMs(2)).toBe(DEFAULT_BASE_DELAY_MS * 2);
    expect(computeBackoffDelayMs(3)).toBe(DEFAULT_BASE_DELAY_MS * 4);
  });

  it("plafonne au maximum configuré", () => {
    expect(computeBackoffDelayMs(20)).toBe(DEFAULT_MAX_DELAY_MS);
  });

  it("respecte des options personnalisées", () => {
    expect(computeBackoffDelayMs(1, { baseDelayMs: 100, maxDelayMs: 300 })).toBe(100);
    expect(computeBackoffDelayMs(2, { baseDelayMs: 100, maxDelayMs: 300 })).toBe(200);
    expect(computeBackoffDelayMs(3, { baseDelayMs: 100, maxDelayMs: 300 })).toBe(300);
    expect(computeBackoffDelayMs(4, { baseDelayMs: 100, maxDelayMs: 300 })).toBe(300);
  });
});
