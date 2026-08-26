import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import DeleteNoteAction from "./DeleteNoteAction";

describe("DeleteNoteAction", () => {
  it("exige une confirmation explicite avant de supprimer quoi que ce soit", () => {
    const onDelete = vi.fn();
    render(<DeleteNoteAction noteId="note-1" onDelete={onDelete} onDeleted={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /supprimer cette note/i }));

    expect(screen.getByText(/irréversible/i)).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("annuler revient à l'état initial sans rien supprimer", () => {
    const onDelete = vi.fn();
    render(<DeleteNoteAction noteId="note-1" onDelete={onDelete} onDeleted={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /supprimer cette note/i }));
    fireEvent.click(screen.getByRole("button", { name: /annuler/i }));

    expect(screen.getByRole("button", { name: /supprimer cette note/i })).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("confirmer appelle onDelete puis onDeleted en cas de succès", async () => {
    const onDelete = vi.fn(async () => {});
    const onDeleted = vi.fn();
    render(<DeleteNoteAction noteId="note-1" onDelete={onDelete} onDeleted={onDeleted} />);

    fireEvent.click(screen.getByRole("button", { name: /supprimer cette note/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirmer la suppression/i }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("note-1"));
    expect(onDelete).toHaveBeenCalledWith("note-1");
  });

  it("affiche l'échec en role alert et n'appelle jamais onDeleted", async () => {
    const onDelete = vi.fn(async () => {
      throw new Error("Le serveur a refusé la suppression.");
    });
    const onDeleted = vi.fn();
    render(<DeleteNoteAction noteId="note-1" onDelete={onDelete} onDeleted={onDeleted} />);

    fireEvent.click(screen.getByRole("button", { name: /supprimer cette note/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirmer la suppression/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Le serveur a refusé la suppression.");
    expect(alert).toHaveTextContent(/restent intacts/i);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("permet de réessayer après un échec", async () => {
    const onDelete = vi.fn().mockRejectedValueOnce(new Error("Panne réseau.")).mockResolvedValueOnce(undefined);
    const onDeleted = vi.fn();
    render(<DeleteNoteAction noteId="note-1" onDelete={onDelete} onDeleted={onDeleted} />);

    fireEvent.click(screen.getByRole("button", { name: /supprimer cette note/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirmer la suppression/i }));
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: /réessayer/i }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("note-1"));
    expect(onDelete).toHaveBeenCalledTimes(2);
  });
});
