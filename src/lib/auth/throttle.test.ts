// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isThrottled,
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
});
