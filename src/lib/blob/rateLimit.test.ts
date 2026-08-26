// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getTrackedIpCountForTests,
  isRateLimited,
  MAX_TRACKED_IPS,
  recordRequest,
  resetRateLimitStateForTests,
} from "./rateLimit";

const MAX_REQUESTS = 60;
const WINDOW_MS = 5 * 60 * 1000;

describe("rateLimit", () => {
  beforeEach(() => {
    resetRateLimitStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("n'est pas limité avant le plafond", () => {
    const ip = "1.2.3.4";
    for (let i = 0; i < MAX_REQUESTS - 1; i += 1) recordRequest(ip);
    expect(isRateLimited(ip)).toBe(false);
  });

  it("limite à partir de la requête qui atteint le plafond dans la fenêtre", () => {
    const ip = "1.2.3.5";
    for (let i = 0; i < MAX_REQUESTS; i += 1) recordRequest(ip);
    expect(isRateLimited(ip)).toBe(true);
  });

  it("compte chaque requête, pas seulement les échecs (contrairement au throttle de connexion)", () => {
    // Ce test documente la différence délibérée avec `auth/throttle.ts` :
    // ici, une requête réussie compte aussi contre le plafond.
    const ip = "1.2.3.6";
    for (let i = 0; i < MAX_REQUESTS; i += 1) recordRequest(ip);
    expect(isRateLimited(ip)).toBe(true);
  });

  it("n'affecte pas les autres IP", () => {
    const ip = "1.2.3.7";
    const otherIp = "9.9.9.9";
    for (let i = 0; i < MAX_REQUESTS; i += 1) recordRequest(ip);
    expect(isRateLimited(otherIp)).toBe(false);
  });

  it("le compteur expire après la fenêtre de 5 minutes", () => {
    vi.useFakeTimers();
    const ip = "1.2.3.8";
    for (let i = 0; i < MAX_REQUESTS; i += 1) recordRequest(ip);
    expect(isRateLimited(ip)).toBe(true);

    vi.advanceTimersByTime(WINDOW_MS + 1);
    expect(isRateLimited(ip)).toBe(false);
  });

  it("plafonne le nombre d'IP suivies", () => {
    for (let i = 0; i < MAX_TRACKED_IPS + 200; i += 1) {
      recordRequest(`203.0.113.${i}`);
    }
    expect(getTrackedIpCountForTests()).toBeLessThanOrEqual(MAX_TRACKED_IPS);
  });
});
