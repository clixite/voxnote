import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import TimerDisplay from "./TimerDisplay";

describe("TimerDisplay", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("affiche 00:00 au départ", () => {
    render(<TimerDisplay elapsedMs={0} state="idle" />);
    expect(screen.getByText("00:00")).toBeInTheDocument();
  });

  it("s'incrémente localement pendant l'enregistrement, sans attendre le hook", () => {
    vi.useFakeTimers();
    render(<TimerDisplay elapsedMs={0} state="recording" />);

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByText("00:03")).toBeInTheDocument();
  });

  it("se fige quand l'enregistrement passe en pause", () => {
    vi.useFakeTimers();
    const { rerender } = render(<TimerDisplay elapsedMs={5000} state="recording" />);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("00:07")).toBeInTheDocument();

    // Le hook referme le segment à la pause et fige `elapsedMs` à 7000.
    rerender(<TimerDisplay elapsedMs={7000} state="paused" />);
    expect(screen.getByText("00:07")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("00:07")).toBeInTheDocument();
  });

  it("affiche hh:mm:ss au-delà d'une heure", () => {
    render(<TimerDisplay elapsedMs={3661000} state="paused" />);
    expect(screen.getByText("1:01:01")).toBeInTheDocument();
  });
});
