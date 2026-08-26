import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import LevelMeter from "./LevelMeter";

describe("LevelMeter", () => {
  it("n'affiche aucune barre remplie à un niveau nul", () => {
    const { container } = render(<LevelMeter level={0} />);
    expect(container.querySelectorAll('[data-filled="true"]')).toHaveLength(0);
  });

  it("remplit toutes les barres à un niveau maximal", () => {
    const { container } = render(<LevelMeter level={1} />);
    const total = container.querySelectorAll("[data-filled]").length;
    expect(container.querySelectorAll('[data-filled="true"]')).toHaveLength(total);
  });

  it("remplit une partie des barres à un niveau intermédiaire", () => {
    const { container } = render(<LevelMeter level={0.5} />);
    const total = container.querySelectorAll("[data-filled]").length;
    const filled = container.querySelectorAll('[data-filled="true"]').length;
    expect(filled).toBeGreaterThan(0);
    expect(filled).toBeLessThan(total);
  });

  it("tolère une valeur hors bornes ou invalide", () => {
    const { container: over } = render(<LevelMeter level={2} />);
    const total = over.querySelectorAll("[data-filled]").length;
    expect(over.querySelectorAll('[data-filled="true"]')).toHaveLength(total);

    const { container: invalid } = render(<LevelMeter level={Number.NaN} />);
    expect(invalid.querySelectorAll('[data-filled="true"]')).toHaveLength(0);
  });

  it("est décoratif pour les lecteurs d'écran", () => {
    const { container } = render(<LevelMeter level={0.5} />);
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
  });
});
