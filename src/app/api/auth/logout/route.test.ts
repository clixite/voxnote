// @vitest-environment node
import { describe, expect, it } from "vitest";

import { POST } from "./route";

describe("POST /api/auth/logout", () => {
  it("efface le cookie et renvoie 204, sans exiger de session valide", async () => {
    const response = await POST();

    expect(response.status).toBe(204);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("vox_session=");
    expect(setCookie).toMatch(/Max-Age=0/i);
  });

  it("est idempotente : un second appel se comporte à l'identique", async () => {
    const first = await POST();
    const second = await POST();
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
  });
});
