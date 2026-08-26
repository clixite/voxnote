import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HomePage from "./page";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

describe("HomePage", () => {
  beforeEach(() => {
    pushMock.mockClear();
  });


  it("affiche le bouton Enregistrer prêt à démarrer un enregistrement", () => {
    render(<HomePage />);

    const button = screen.getByRole("button", { name: /enregistrer/i });
    expect(button).not.toBeDisabled();
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

  it("affiche un bouton de déconnexion", () => {
    render(<HomePage />);

    expect(
      screen.getByRole("button", { name: /se déconnecter/i }),
    ).toBeInTheDocument();
  });
});
