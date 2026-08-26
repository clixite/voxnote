import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ErrorBanner from "./ErrorBanner";

describe("ErrorBanner", () => {
  it("n'affiche rien sans message", () => {
    render(<ErrorBanner message={undefined} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("affiche le message tel quel en role alert, et propose de réessayer", () => {
    const onRetry = vi.fn();
    render(<ErrorBanner message="Message de test." onRetry={onRetry} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Message de test.");

    fireEvent.click(screen.getByRole("button", { name: /réessayer/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("n'affiche pas de bouton réessayer si aucun gestionnaire n'est fourni", () => {
    render(<ErrorBanner message="Erreur inconnue." />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  // Le texte du message vient du hook (src/lib/recorder/errors.ts) et peut
  // être reformulé sans préavis : on n'assertionne jamais dessus. Le conseil
  // ci-dessous appartient entièrement à ce composant, dérivé du `code`.
  it("donne un conseil pour permission refusée", () => {
    render(<ErrorBanner message="Message de test." code="permission-denied" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/autorise le micro/i);
  });

  it("donne un conseil pour aucun microphone détecté", () => {
    render(<ErrorBanner message="Message de test." code="no-microphone" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/aucun micro n'est détecté/i);
  });

  it("donne un conseil pour microphone occupé", () => {
    render(<ErrorBanner message="Message de test." code="microphone-busy" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/utilise déjà le micro/i);
  });

  it("n'affiche aucun conseil inventé pour un code sans réponse fiable", () => {
    render(<ErrorBanner message="Message de test." code="note-not-found" />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Message de test.");
    // Un seul paragraphe (le message) : pas de deuxième <p> de conseil.
    expect(alert.querySelectorAll("p")).toHaveLength(1);
  });

  it("n'affiche aucun conseil sans code fourni", () => {
    render(<ErrorBanner message="Message de test." />);
    expect(screen.getByRole("alert").querySelectorAll("p")).toHaveLength(1);
  });
});
