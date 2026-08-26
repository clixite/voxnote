import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import OtherTabNotice from "./OtherTabNotice";

describe("OtherTabNotice", () => {
  it("signale que l'enregistrement est en cours dans un autre onglet, sans proposer d'action", () => {
    render(<OtherTabNotice createdAt={Date.parse("2026-08-20T10:00:00Z")} />);

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/en cours dans un autre onglet/i);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
