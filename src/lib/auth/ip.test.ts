// @vitest-environment node
import { describe, expect, it } from "vitest";

import { getClientIp } from "./ip";

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers,
  });
}

describe("getClientIp", () => {
  it("priorise x-vercel-forwarded-for (posé par la plateforme, jamais par le client)", () => {
    const request = requestWithHeaders({
      "x-vercel-forwarded-for": "203.0.113.1",
      "x-real-ip": "203.0.113.2",
      "x-forwarded-for": "203.0.113.3",
    });
    expect(getClientIp(request)).toBe("203.0.113.1");
  });

  it("retombe sur x-real-ip si x-vercel-forwarded-for est absent", () => {
    const request = requestWithHeaders({
      "x-real-ip": "203.0.113.2",
      "x-forwarded-for": "203.0.113.3",
    });
    expect(getClientIp(request)).toBe("203.0.113.2");
  });

  it("retombe sur x-forwarded-for en dernier recours seulement", () => {
    const request = requestWithHeaders({
      "x-forwarded-for": "203.0.113.3",
    });
    expect(getClientIp(request)).toBe("203.0.113.3");
  });

  it("prend la première IP d'une chaîne x-forwarded-for", () => {
    const request = requestWithHeaders({
      "x-forwarded-for": "203.0.113.3, 70.41.3.18, 150.172.238.178",
    });
    expect(getClientIp(request)).toBe("203.0.113.3");
  });

  it("renvoie 'unknown' si aucun en-tête n'est présent", () => {
    const request = requestWithHeaders({});
    expect(getClientIp(request)).toBe("unknown");
  });

  it("un x-forwarded-for tournant ne change plus la clé de throttling dès qu'un en-tête de plateforme est présent", () => {
    // C'est l'exploit démontré par la revue : sans x-vercel-forwarded-for
    // (absent en local/CI, mais toujours présent sur Vercel), un attaquant
    // qui fait tourner x-forwarded-for obtient une IP différente à chaque
    // requête. On vérifie ici que dès que la plateforme pose son en-tête,
    // il prime et neutralise ce contournement.
    const first = getClientIp(
      requestWithHeaders({
        "x-vercel-forwarded-for": "198.51.100.9",
        "x-forwarded-for": "1.1.1.1",
      }),
    );
    const second = getClientIp(
      requestWithHeaders({
        "x-vercel-forwarded-for": "198.51.100.9",
        "x-forwarded-for": "2.2.2.2",
      }),
    );
    expect(first).toBe(second);
    expect(first).toBe("198.51.100.9");
  });
});
