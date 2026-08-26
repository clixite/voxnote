import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LogoutButton from "./LogoutButton";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

function mockFetchResponse(status: number): Response {
  return { status } as Response;
}

describe("LogoutButton", () => {
  beforeEach(() => {
    pushMock.mockClear();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("appelle POST /api/auth/logout puis redirige vers /login", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(204));
    render(<LogoutButton />);

    fireEvent.click(screen.getByRole("button", { name: /se déconnecter/i }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/login"));
    expect(fetch).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
  });

  it("redirige vers /login même si l'appel réseau échoue", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<LogoutButton />);

    fireEvent.click(screen.getByRole("button", { name: /se déconnecter/i }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/login"));
  });
});
