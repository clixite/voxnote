import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ResumeNotice from "./ResumeNotice";

describe("ResumeNotice", () => {
  const note = {
    noteId: "note-1",
    createdAt: Date.parse("2026-08-20T10:00:00Z"),
    segmentCount: 3,
    durationMs: 125000,
  };

  it("signale la note non terminée avec son nombre de segments", () => {
    render(<ResumeNotice note={note} onResume={vi.fn()} onFinish={vi.fn()} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/non terminé/i);
    expect(banner).toHaveTextContent(/3 segments/i);
  });

  it("propose de reprendre ou de terminer", () => {
    const onResume = vi.fn();
    const onFinish = vi.fn();
    render(<ResumeNotice note={note} onResume={onResume} onFinish={onFinish} />);

    fireEvent.click(screen.getByRole("button", { name: /reprendre l'enregistrement/i }));
    expect(onResume).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /terminer cette note/i }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("accorde le texte au singulier pour un seul segment", () => {
    render(
      <ResumeNotice
        note={{ ...note, segmentCount: 1 }}
        onResume={vi.fn()}
        onFinish={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/1 segment déjà enregistré et sauvegardé/i);
  });
});
