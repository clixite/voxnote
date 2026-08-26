import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import RecordButton from "./RecordButton";

describe("RecordButton", () => {
  it("propose de démarrer l'enregistrement à l'état idle", () => {
    const onStart = vi.fn();
    render(<RecordButton state="idle" onStart={onStart} onStop={vi.fn()} />);

    const button = screen.getByRole("button", { name: /enregistrer/i });
    fireEvent.click(button);

    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("devient le contrôle d'arrêt pendant l'enregistrement", () => {
    const onStop = vi.fn();
    render(<RecordButton state="recording" onStart={vi.fn()} onStop={onStop} />);

    const button = screen.getByRole("button", { name: /arrêter/i });
    fireEvent.click(button);

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /^enregistrer$/i })).not.toBeInTheDocument();
  });

  it("reste le contrôle d'arrêt pendant la pause", () => {
    render(<RecordButton state="paused" onStart={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByRole("button", { name: /arrêter/i })).toBeInTheDocument();
  });

  it("redevient « Enregistrer » après un arrêt ou une erreur", () => {
    const { rerender } = render(<RecordButton state="stopped" onStart={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByRole("button", { name: /enregistrer/i })).toBeInTheDocument();

    rerender(<RecordButton state="error" onStart={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByRole("button", { name: /enregistrer/i })).toBeInTheDocument();
  });

  it("est désactivé si aucun mimeType n'est supporté", () => {
    render(<RecordButton state="idle" disabled onStart={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByRole("button", { name: /enregistrer/i })).toBeDisabled();
  });
});
