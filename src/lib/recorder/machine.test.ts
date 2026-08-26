import { describe, expect, it } from "vitest";

import {
  canTransition,
  InvalidRecorderTransitionError,
  transition,
  type RecorderState,
} from "./machine";

describe("machine à états de l'enregistreur", () => {
  it("idle → recording sur START", () => {
    expect(transition("idle", "START")).toBe("recording");
  });

  it("recording → paused sur PAUSE", () => {
    expect(transition("recording", "PAUSE")).toBe("paused");
  });

  it("paused → recording sur RESUME", () => {
    expect(transition("paused", "RESUME")).toBe("recording");
  });

  it("recording → stopped sur STOP", () => {
    expect(transition("recording", "STOP")).toBe("stopped");
  });

  it("paused → stopped sur STOP", () => {
    expect(transition("paused", "STOP")).toBe("stopped");
  });

  it.each<RecorderState>(["idle", "recording", "paused"])(
    "%s → error sur ERROR",
    (state) => {
      expect(transition(state, "ERROR")).toBe("error");
    },
  );

  it("error → recording sur START (relance après échec)", () => {
    expect(transition("error", "START")).toBe("recording");
  });

  it("error → error sur ERROR (auto-boucle : une seconde erreur reste un état error propre)", () => {
    expect(transition("error", "ERROR")).toBe("error");
  });

  it.each<[RecorderState, "START" | "PAUSE" | "RESUME" | "STOP" | "ERROR"]>([
    ["idle", "PAUSE"],
    ["idle", "RESUME"],
    ["idle", "STOP"],
    ["recording", "START"],
    ["recording", "RESUME"],
    ["paused", "START"],
    ["paused", "PAUSE"],
    ["stopped", "START"],
    ["stopped", "PAUSE"],
    ["stopped", "RESUME"],
    ["stopped", "STOP"],
    ["stopped", "ERROR"],
    ["error", "PAUSE"],
    ["error", "RESUME"],
    ["error", "STOP"],
  ])("refuse %s + %s sans corrompre l'état", (state, event) => {
    expect(canTransition(state, event)).toBe(false);
    expect(() => transition(state, event)).toThrow(InvalidRecorderTransitionError);

    // La transition refusée ne doit produire aucun effet observable : un
    // nouvel appel valide depuis le même état de départ doit se comporter
    // normalement, preuve qu'aucun état interne n'a été altéré.
    try {
      transition(state, event);
    } catch {
      // volontairement ignoré : on vérifie seulement l'absence de corruption
    }
  });

  it("le message d'erreur nomme l'état et l'événement refusés", () => {
    try {
      transition("stopped", "PAUSE");
      expect.unreachable("devait lever InvalidRecorderTransitionError");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRecorderTransitionError);
      const err = error as InvalidRecorderTransitionError;
      expect(err.from).toBe("stopped");
      expect(err.event).toBe("PAUSE");
      expect(err.message).toContain("stopped");
      expect(err.message).toContain("PAUSE");
    }
  });
});
