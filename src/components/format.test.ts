import { describe, expect, it } from "vitest";

import { formatDuration } from "./format";

describe("formatDuration", () => {
  it("formate en mm:ss sous une heure", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(5000)).toBe("00:05");
    expect(formatDuration(65000)).toBe("01:05");
    expect(formatDuration(3599000)).toBe("59:59");
  });

  it("formate en h:mm:ss au-delà d'une heure", () => {
    expect(formatDuration(3600000)).toBe("1:00:00");
    expect(formatDuration(3661000)).toBe("1:01:01");
  });

  it("tolère les valeurs négatives ou invalides sans planter", () => {
    expect(formatDuration(-500)).toBe("00:00");
    expect(formatDuration(Number.NaN)).toBe("00:00");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("00:00");
  });
});
