import { describe, expect, it } from "vitest";

import {
  duplicateSegmentError,
  maxDurationReachedError,
  messageFor,
  nonRetryableStoreError,
  noSupportedMimeTypeError,
  noteNotFoundError,
  RecorderError,
  storageFullError,
  toRecorderError,
} from "./errors";

describe("toRecorderError", () => {
  it.each([
    ["NotAllowedError", "permission-denied"],
    ["PermissionDeniedError", "permission-denied"],
    ["NotFoundError", "no-microphone"],
    ["DevicesNotFoundError", "no-microphone"],
    ["NotReadableError", "microphone-busy"],
    ["TrackStartError", "microphone-busy"],
    ["OverconstrainedError", "unsupported-constraints"],
    ["SecurityError", "insecure-context"],
    ["AbortError", "aborted"],
    ["QuelqueChoseDInconnu", "unknown"],
  ] as const)("mappe DOMException %s → code %s", (name, code) => {
    const error = toRecorderError(new DOMException("détail technique", name));
    expect(error).toBeInstanceOf(RecorderError);
    expect(error.code).toBe(code);
    expect(error.message).toBe(messageFor(code));
    // Jamais le message technique brut affiché à l'utilisateur.
    expect(error.message).not.toContain("détail technique");
    expect(error.message).not.toContain(name);
  });

  it("gère une erreur qui n'est pas une DOMException", () => {
    const error = toRecorderError(new Error("boom"));
    expect(error.code).toBe("unknown");
  });

  it("gère une valeur qui n'est pas une Error du tout", () => {
    const error = toRecorderError("boom");
    expect(error.code).toBe("unknown");
  });

  it("laisse passer une RecorderError déjà construite", () => {
    const original = noSupportedMimeTypeError();
    expect(toRecorderError(original)).toBe(original);
  });

  it("tous les messages sont en français et non vides", () => {
    const codes = [
      "permission-denied",
      "no-microphone",
      "microphone-busy",
      "unsupported-constraints",
      "insecure-context",
      "aborted",
      "no-supported-mime-type",
      "max-duration-reached",
      "note-not-found",
      "duplicate-segment",
      "storage-full",
      "unknown",
    ] as const;
    for (const code of codes) {
      expect(messageFor(code).length).toBeGreaterThan(0);
    }
  });

  it("tutoie systématiquement : aucun message ne vouvoie (CLAUDE.md #6, sans exception)", () => {
    const codes = [
      "permission-denied",
      "no-microphone",
      "microphone-busy",
      "unsupported-constraints",
      "insecure-context",
      "aborted",
      "no-supported-mime-type",
      "max-duration-reached",
      "note-not-found",
      "duplicate-segment",
      "storage-full",
      "unknown",
    ] as const;
    for (const code of codes) {
      expect(messageFor(code)).not.toMatch(/\b(vous|votre|vos)\b/i);
    }
  });

  it("chaque message dit quoi faire, pas seulement ce qui a échoué", () => {
    // Un verbe à l'impératif (2e pers. du singulier) ou une consigne
    // explicite : la preuve qu'il reste une action à faire, pas seulement un
    // constat d'échec.
    const actionPattern =
      /réessaie|autorise|ferme|branche|démarre|essaie|ouvre|utilise|redémarre|vérifie|termine|arrête/i;
    const codes = [
      "permission-denied",
      "no-microphone",
      "microphone-busy",
      "unsupported-constraints",
      "insecure-context",
      "aborted",
      "no-supported-mime-type",
      "max-duration-reached",
      "note-not-found",
      "duplicate-segment",
      "storage-full",
      "unknown",
    ] as const;
    for (const code of codes) {
      expect(messageFor(code)).toMatch(actionPattern);
    }
  });
});

describe("erreurs dédiées", () => {
  it("noSupportedMimeTypeError porte le bon code et un message actionnable", () => {
    const error = noSupportedMimeTypeError();
    expect(error.code).toBe("no-supported-mime-type");
    expect(error.message).toMatch(/navigateur/i);
  });

  it("maxDurationReachedError mentionne la durée maximale", () => {
    const error = maxDurationReachedError();
    expect(error.code).toBe("max-duration-reached");
    expect(error.message).toMatch(/2 heures/);
  });

  it("noteNotFoundError signale que la note n'existe plus, en français", () => {
    const error = noteNotFoundError();
    expect(error.code).toBe("note-not-found");
    expect(error.message).toMatch(/n'existe plus/);
  });

  it("storageFullError dit la vérité : le stockage est plein, rien de ce qui est déjà enregistré n'est perdu (BLOQUANT B1)", () => {
    const error = storageFullError();
    expect(error.code).toBe("storage-full");
    expect(error.message).toMatch(/plein/);
    // Le message ne doit jamais laisser croire à une perte de données déjà
    // écrites : c'est tout le sens de la garde B1 dans RecorderEngine.
    expect(error.message).toMatch(/intact|sauvegardé|déjà enregistré/);
  });

  it("duplicateSegmentError pointe la vraie cause (un autre onglet), jamais 'stockage plein'", () => {
    const error = duplicateSegmentError();
    expect(error.code).toBe("duplicate-segment");
    expect(error.message).toMatch(/autre onglet/);
    expect(error.message).not.toMatch(/stockage|plein/i);
  });
});

describe("nonRetryableStoreError", () => {
  it("reconnaît DuplicateSegmentSeqError (deux onglets sur la même note) : ne retente pas, dit la vraie cause", () => {
    const raw = new Error("Un segment porte déjà le seq 3 pour la note note-1");
    raw.name = "DuplicateSegmentSeqError";
    const error = nonRetryableStoreError(raw);
    expect(error).toBeInstanceOf(RecorderError);
    expect(error?.code).toBe("duplicate-segment");
    expect(error?.message).toMatch(/autre onglet/);
  });

  it("reconnaît NoteNotFoundError (note disparue) : ne retente pas", () => {
    const raw = new Error("Note introuvable : note-1");
    raw.name = "NoteNotFoundError";
    const error = nonRetryableStoreError(raw);
    expect(error).toBeInstanceOf(RecorderError);
    expect(error?.code).toBe("note-not-found");
  });

  it("renvoie undefined pour une erreur inconnue (quota, base bloquée...) : candidate à une reprise", () => {
    expect(nonRetryableStoreError(new Error("QuotaExceededError simulé"))).toBeUndefined();
    expect(nonRetryableStoreError(new DOMException("bloqué", "InvalidStateError"))).toBeUndefined();
    expect(nonRetryableStoreError("pas une Error du tout")).toBeUndefined();
    expect(nonRetryableStoreError(undefined)).toBeUndefined();
  });

  it("n'a pas besoin d'instanceof : reconnaît une erreur par son .name, quelle que soit son implémentation NoteStore d'origine", () => {
    class UnrelatedButSameName extends Error {
      constructor() {
        super("peu importe");
        this.name = "DuplicateSegmentSeqError";
      }
    }
    expect(nonRetryableStoreError(new UnrelatedButSameName())?.code).toBe("duplicate-segment");
  });
});
