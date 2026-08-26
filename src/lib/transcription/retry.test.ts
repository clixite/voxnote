// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  audioUnreadableError,
  providerUnavailableError,
  TranscriptionError,
} from "./errors";
import { withRetry } from "./retry";

function fakeSleep() {
  const calls: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    calls.push(ms);
  });
  return { sleep, calls };
}

describe("withRetry", () => {
  it("réussit du premier coup sans attendre", async () => {
    const { sleep } = fakeSleep();
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withRetry(fn, { sleep });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("erreur transitoire : réessaie et finit par réussir", async () => {
    const { sleep, calls } = fakeSleep();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(providerUnavailableError("panne 1"))
      .mockRejectedValueOnce(providerUnavailableError("panne 2"))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, { sleep, baseDelayMs: 10 });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    // Backoff exponentiel : 10ms puis 20ms.
    expect(calls).toEqual([10, 20]);
  });

  it("erreur définitive (non retryable) : échoue immédiatement, sans réessayer", async () => {
    const { sleep } = fakeSleep();
    const error = audioUnreadableError("format inconnu");
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { sleep })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("erreur transitoire qui persiste : abandonne après le nombre d'essais configuré", async () => {
    const { sleep } = fakeSleep();
    const error = providerUnavailableError("toujours en panne");
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { sleep, attempts: 3, baseDelayMs: 5 })).rejects.toBe(
      error,
    );
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("une erreur qui n'est pas une TranscriptionError n'est jamais réessayée", async () => {
    const { sleep } = fakeSleep();
    const bug = new Error("bug de programmation");
    const fn = vi.fn().mockRejectedValue(bug);

    await expect(withRetry(fn, { sleep })).rejects.toBe(bug);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("appelle onRetry avec l'erreur, la tentative et le délai", async () => {
    const { sleep } = fakeSleep();
    const error = providerUnavailableError("panne");
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("ok");
    const onRetry = vi.fn();

    await withRetry(fn, { sleep, baseDelayMs: 7, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.any(TranscriptionError), 1, 7);
  });
});
