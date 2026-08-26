// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getTrackedIpCountForTests,
  isThrottled,
  MAX_TRACKED_IPS,
  recordFailedAttempt,
  resetAttempts,
  resetThrottleStateForTests,
} from "./throttle";

describe("throttle", () => {
  beforeEach(() => {
    resetThrottleStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("n'est pas throttlé avant la limite", () => {
    const ip = "1.2.3.4";
    for (let i = 0; i < 9; i += 1) recordFailedAttempt(ip);
    expect(isThrottled(ip)).toBe(false);
  });

  it("throttle à partir de la 10e tentative échouée dans la fenêtre", () => {
    const ip = "1.2.3.5";
    for (let i = 0; i < 10; i += 1) recordFailedAttempt(ip);
    expect(isThrottled(ip)).toBe(true);
  });

  it("n'affecte pas les autres IP", () => {
    const ip = "1.2.3.6";
    const otherIp = "9.9.9.9";
    for (let i = 0; i < 10; i += 1) recordFailedAttempt(ip);
    expect(isThrottled(otherIp)).toBe(false);
  });

  it("resetAttempts efface le compteur (connexion réussie)", () => {
    const ip = "1.2.3.7";
    for (let i = 0; i < 10; i += 1) recordFailedAttempt(ip);
    expect(isThrottled(ip)).toBe(true);

    resetAttempts(ip);
    expect(isThrottled(ip)).toBe(false);
  });

  it("le compteur expire après la fenêtre de 5 minutes", () => {
    vi.useFakeTimers();
    const ip = "1.2.3.8";
    for (let i = 0; i < 10; i += 1) recordFailedAttempt(ip);
    expect(isThrottled(ip)).toBe(true);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(isThrottled(ip)).toBe(false);
  });

  it("purge les entrées expirées d'AUTRES IP à l'occasion d'un nouvel échec (pas seulement celle consultée)", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 50; i += 1) recordFailedAttempt(`10.0.0.${i}`);
    expect(getTrackedIpCountForTests()).toBe(50);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    // Un seul nouvel échec, sur une IP différente, doit déclencher le
    // nettoyage des 50 entrées expirées ci-dessus.
    recordFailedAttempt("10.0.1.1");
    expect(getTrackedIpCountForTests()).toBe(1);
  });

  it("plafonne le nombre d'IP suivies (une IP forgée par tentative ne fait pas grossir la mémoire sans limite)", () => {
    for (let i = 0; i < MAX_TRACKED_IPS + 200; i += 1) {
      recordFailedAttempt(`203.0.113.${i}`);
    }
    expect(getTrackedIpCountForTests()).toBeLessThanOrEqual(MAX_TRACKED_IPS);
  });
});
