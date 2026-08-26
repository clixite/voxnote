// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getTrackedIpCountForTests,
  isRateLimited,
  MAX_TRACKED_IPS,
  resetRateLimitStateForTests,
} from "./rate-limit";

describe("isRateLimited", () => {
  beforeEach(() => {
    resetRateLimitStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("n'est pas limité avant le plafond", () => {
    const ip = "1.2.3.4";
    for (let i = 0; i < 39; i += 1) expect(isRateLimited(ip)).toBe(false);
  });

  it("limite à partir de la 41e requête dans la fenêtre", () => {
    const ip = "1.2.3.5";
    for (let i = 0; i < 40; i += 1) expect(isRateLimited(ip)).toBe(false);
    expect(isRateLimited(ip)).toBe(true);
  });

  it("n'affecte pas les autres IP", () => {
    const ip = "1.2.3.6";
    const otherIp = "9.9.9.9";
    for (let i = 0; i < 41; i += 1) isRateLimited(ip);
    expect(isRateLimited(otherIp)).toBe(false);
  });

  it("le compteur expire après la fenêtre de 5 minutes", () => {
    vi.useFakeTimers();
    const ip = "1.2.3.7";
    for (let i = 0; i < 41; i += 1) isRateLimited(ip);
    expect(isRateLimited(ip)).toBe(true);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(isRateLimited(ip)).toBe(false);
  });

  it("plafonne le nombre d'IP suivies", () => {
    for (let i = 0; i < MAX_TRACKED_IPS + 200; i += 1) {
      isRateLimited(`203.0.113.${i}`);
    }
    expect(getTrackedIpCountForTests()).toBeLessThanOrEqual(MAX_TRACKED_IPS);
  });
});
