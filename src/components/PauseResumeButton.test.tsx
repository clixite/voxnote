import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import PauseResumeButton from "./PauseResumeButton";

describe("PauseResumeButton", () => {
  it("propose de mettre en pause pendant l'enregistrement", () => {
    const onPause = vi.fn();
    render(<PauseResumeButton state="recording" onPause={onPause} onResume={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /pause/i }));
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it("propose de reprendre quand l'enregistrement est en pause", () => {
    const onResume = vi.fn();
    render(<PauseResumeButton state="paused" onPause={vi.fn()} onResume={onResume} />);

    fireEvent.click(screen.getByRole("button", { name: /reprendre/i }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
