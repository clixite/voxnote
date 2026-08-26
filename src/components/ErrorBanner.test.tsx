import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ErrorBanner from "./ErrorBanner";

describe("ErrorBanner", () => {
  it("n'affiche rien sans message", () => {
    render(<ErrorBanner message={undefined} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("affiche le message français tel quel, en role alert, avec une porte de sortie", () => {
    const onRetry = vi.fn();
    render(
      <ErrorBanner
        message="Accès au microphone refusé. Autorisez le microphone pour ce site dans les réglages de votre navigateur, puis réessayez."
        onRetry={onRetry}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Accès au microphone refusé.");
    expect(alert).toHaveTextContent(/réglages de ton navigateur/i);

    fireEvent.click(screen.getByRole("button", { name: /réessayer/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("n'affiche pas de bouton réessayer si aucun gestionnaire n'est fourni", () => {
    render(<ErrorBanner message="Erreur inconnue." />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
