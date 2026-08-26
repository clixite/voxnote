import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginForm from "./LoginForm";

const pushMock = vi.fn();
const refreshMock = vi.fn();
let searchParamsValue = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
  useSearchParams: () => searchParamsValue,
}));

function mockFetchResponse(status: number, body?: unknown): Response {
  return {
    status,
    json: async () => body,
  } as Response;
}

function typePassword(value: string) {
  fireEvent.change(screen.getByLabelText(/mot de passe/i), {
    target: { value },
  });
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: /se connecter/i }));
}

describe("LoginForm", () => {
  beforeEach(() => {
    pushMock.mockClear();
    refreshMock.mockClear();
    searchParamsValue = new URLSearchParams();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("redirige vers / et rafraîchit le router après une connexion réussie sans destination demandée", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(204));
    render(<LoginForm />);

    typePassword("secret");
    submit();

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/"));
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("redirige vers la page initialement demandée (from) après succès", async () => {
    searchParamsValue = new URLSearchParams({ from: "/notes/42" });
    vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(204));
    render(<LoginForm />);

    typePassword("secret");
    submit();

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/notes/42"));
  });

  it("ignore une valeur from protocole-relative et redirige vers / (anti open-redirect)", async () => {
    searchParamsValue = new URLSearchParams({ from: "//evil.example" });
    vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(204));
    render(<LoginForm />);

    typePassword("secret");
    submit();

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/"));
  });

  it("ignore une valeur from en /\\ (contournement navigateur connu) et redirige vers /", async () => {
    // Les navigateurs normalisent l'antislash en double slash : "/\evil.example"
    // équivaut à "//evil.example" et doit être rejeté au même titre.
    searchParamsValue = new URLSearchParams({ from: "/\\evil.example" });
    vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(204));
    render(<LoginForm />);

    typePassword("secret");
    submit();

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/"));
  });

  it("affiche le message d'erreur du serveur pour un mot de passe incorrect (401)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockFetchResponse(401, {
        error: "INVALID_PASSWORD",
        message: "Mot de passe incorrect.",
      }),
    );
    render(<LoginForm />);

    typePassword("mauvais-mot-de-passe");
    submit();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Mot de passe incorrect.");
    expect(screen.getByLabelText(/mot de passe/i)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("affiche le message de throttling pour une réponse 429", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockFetchResponse(429, {
        error: "TOO_MANY_ATTEMPTS",
        message: "Trop de tentatives. Réessaie dans quelques minutes.",
      }),
    );
    render(<LoginForm />);

    typePassword("secret");
    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Trop de tentatives. Réessaie dans quelques minutes.",
    );
  });

  it("affiche un message réseau générique si la requête échoue, sans planter", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<LoginForm />);

    typePassword("secret");
    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connexion impossible. Vérifie ta connexion internet.",
    );
  });

  it("désactive le bouton pendant la requête puis le réactive en cas d'erreur", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    render(<LoginForm />);

    typePassword("secret");
    const button = screen.getByRole("button", { name: /se connecter/i });
    submit();

    expect(button).toBeDisabled();

    resolveFetch(mockFetchResponse(401, { message: "Mot de passe incorrect." }));

    await waitFor(() => expect(button).not.toBeDisabled());
  });
});
