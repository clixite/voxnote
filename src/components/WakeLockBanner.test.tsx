import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import WakeLockBanner from "./WakeLockBanner";

describe("WakeLockBanner", () => {
  it("ne s'affiche pas quand le verrou fonctionne", () => {
    render(<WakeLockBanner show={false} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("avertit clairement quand le verrou est indisponible", () => {
    render(<WakeLockBanner show={true} />);
    expect(screen.getByRole("status")).toHaveTextContent(/écran allumé/i);
  });
});
