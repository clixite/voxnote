import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { NoteProgress } from "@/lib/upload/noteRollup";

import UploadProgress from "./UploadProgress";

function progress(overrides: Partial<NoteProgress> = {}): NoteProgress {
  return {
    total: 3,
    uploadedCount: 2,
    transcribedCount: 1,
    errorSegments: [],
    ...overrides,
  };
}

describe("UploadProgress", () => {
  it("n'affiche rien tant qu'il n'y a pas de segment", () => {
    render(<UploadProgress progress={undefined} globalStatus="idle" onRetry={vi.fn()} />);
    expect(screen.queryByTestId("upload-progress")).not.toBeInTheDocument();

    render(<UploadProgress progress={progress({ total: 0, uploadedCount: 0, transcribedCount: 0 })} globalStatus="idle" onRetry={vi.fn()} />);
    expect(screen.queryByTestId("upload-progress")).not.toBeInTheDocument();
  });

  it("affiche les compteurs envoyés/transcrits sur le total", () => {
    render(<UploadProgress progress={progress()} globalStatus="syncing" onRetry={vi.fn()} />);
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    expect(screen.getByText("Envoi en cours")).toBeInTheDocument();
  });

  it("affiche un état global lisible pour chacun des statuts", () => {
    const { rerender } = render(
      <UploadProgress progress={progress()} globalStatus="idle" onRetry={vi.fn()} />,
    );
    expect(screen.getByText("Terminé")).toBeInTheDocument();

    rerender(<UploadProgress progress={progress()} globalStatus="error" onRetry={vi.fn()} />);
    expect(screen.getByText("En erreur")).toBeInTheDocument();

    rerender(<UploadProgress progress={progress()} globalStatus="offline" onRetry={vi.fn()} />);
    expect(screen.getByText("En pause (hors ligne)")).toBeInTheDocument();
  });

  it("liste chaque segment en erreur, en français, avec une action Réessayer", () => {
    const onRetry = vi.fn();
    render(
      <UploadProgress
        progress={progress({
          errorSegments: [{ segmentId: "seg-1", seq: 2, message: "Panne réseau, ça va reprendre." }],
        })}
        globalStatus="error"
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText(/Passage 3/)).toBeInTheDocument();
    expect(screen.getByText(/Panne réseau/)).toBeInTheDocument();

    const button = screen.getByRole("button", { name: "Réessayer" });
    button.click();
    expect(onRetry).toHaveBeenCalledWith("seg-1");
  });
});
