import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import OfflineQueueBanner from "./OfflineQueueBanner";

describe("OfflineQueueBanner", () => {
  it("ne s'affiche pas quand tout va bien", () => {
    render(<OfflineQueueBanner show={false} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("rassure clairement hors-ligne : rien n'est perdu, reprise automatique", () => {
    render(<OfflineQueueBanner show={true} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/connexion/i);
    expect(banner).toHaveTextContent(/sécurité/i);
    expect(banner).toHaveTextContent(/tout seul/i);
  });
});
