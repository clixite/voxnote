import { describe, expect, it } from "vitest";

import type { Segment, Transcript } from "@/types/notes";

import { computeNoteProgress, deriveNoteRollup } from "./noteRollup";

function segment(overrides: Partial<Segment>): Segment {
  return {
    id: overrides.id ?? "seg",
    noteId: "note-1",
    seq: 0,
    blob: new Blob(["x"]),
    mimeType: "audio/webm",
    durationMs: 1000,
    status: "local",
    attempts: 0,
    ...overrides,
  };
}

function transcript(seq: number, text: string): Transcript {
  return { noteId: "note-1", seq, text, provider: "groq", createdAt: Date.now() };
}

describe("deriveNoteRollup", () => {
  it("renvoie undefined pour une note sans le moindre segment", () => {
    expect(deriveNoteRollup([], [])).toBeUndefined();
  });

  it("processing tant qu'un segment n'est ni done ni error", () => {
    const segments = [
      segment({ id: "a", seq: 0, status: "done" }),
      segment({ id: "b", seq: 1, status: "uploading" }),
    ];
    const rollup = deriveNoteRollup(segments, [transcript(0, "bonjour")]);
    expect(rollup?.status).toBe("processing");
  });

  it("done quand tous les segments sont transcrits", () => {
    const segments = [
      segment({ id: "a", seq: 0, status: "done" }),
      segment({ id: "b", seq: 1, status: "done" }),
    ];
    const rollup = deriveNoteRollup(segments, [
      transcript(1, "monde"),
      transcript(0, "bonjour"),
    ]);
    expect(rollup?.status).toBe("done");
    // Assemblage par seq, jamais par ordre d'arrivée des réponses.
    expect(rollup?.text).toBe("bonjour\n\nmonde");
  });

  it("error quand aucun segment n'a abouti", () => {
    const segments = [
      segment({ id: "a", seq: 0, status: "error", error: "boom" }),
      segment({ id: "b", seq: 1, status: "error", error: "boom" }),
    ];
    const rollup = deriveNoteRollup(segments, []);
    expect(rollup?.status).toBe("error");
    expect(rollup?.text).toBeUndefined();
  });

  it("partial quand certains segments sont en erreur et d'autres transcrits, texte lisible depuis ce qui a réussi", () => {
    const segments = [
      segment({ id: "a", seq: 0, status: "done" }),
      segment({ id: "b", seq: 1, status: "error", error: "boom" }),
    ];
    const rollup = deriveNoteRollup(segments, [transcript(0, "bonjour")]);
    expect(rollup?.status).toBe("partial");
    expect(rollup?.text).toBe("bonjour");
  });
});

describe("computeNoteProgress", () => {
  it("compte uploadés (>= uploaded) et transcrits (done) séparément, et liste les erreurs", () => {
    const segments = [
      segment({ id: "a", seq: 0, status: "done" }),
      segment({ id: "b", seq: 1, status: "uploaded" }),
      segment({ id: "c", seq: 2, status: "local" }),
      segment({ id: "d", seq: 3, status: "error", error: "Panne réseau." }),
    ];
    const progress = computeNoteProgress(segments);
    expect(progress.total).toBe(4);
    expect(progress.uploadedCount).toBe(2);
    expect(progress.transcribedCount).toBe(1);
    expect(progress.errorSegments).toEqual([{ segmentId: "d", seq: 3, message: "Panne réseau." }]);
  });
});
