import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "./page";

describe("HomePage", () => {
  it("affiche le bouton Enregistrer désactivé avec la mention bientôt disponible", () => {
    render(<HomePage />);

    const button = screen.getByRole("button", { name: /enregistrer/i });
    expect(button).toBeDisabled();
    expect(screen.getByText(/bientôt disponible/i)).toBeInTheDocument();
  });

  it("affiche le titre VoxNote et un lien vers la page confidentialité", () => {
    render(<HomePage />);

    expect(
      screen.getByRole("heading", { name: "VoxNote" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /confidentialité/i }),
    ).toHaveAttribute("href", "/confidentialite");
  });
});
