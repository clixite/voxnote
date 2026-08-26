// @vitest-environment node
import { describe, expect, it } from "vitest";

import { MAX_SEGMENT_BYTES } from "@/types/api";

import {
  audioPrefixForNote,
  blobPathFor,
  isValidNoteId,
  parseUploadTokenPayload,
  UploadValidationError,
} from "./validation";

const NOTE_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function validPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    noteId: NOTE_ID,
    seq: 0,
    mimeType: "audio/webm",
    sizeBytes: 1024,
    ...overrides,
  });
}

describe("parseUploadTokenPayload", () => {
  it("accepte un payload valide et renvoie les champs typés", () => {
    expect(parseUploadTokenPayload(validPayload())).toEqual({
      noteId: NOTE_ID,
      seq: 0,
      mimeType: "audio/webm",
      sizeBytes: 1024,
    });
  });

  it("rejette un clientPayload absent", () => {
    expect(() => parseUploadTokenPayload(null)).toThrow(UploadValidationError);
  });

  it("rejette un JSON malformé", () => {
    expect(() => parseUploadTokenPayload("{ ceci n'est pas du json")).toThrow(
      UploadValidationError,
    );
  });

  it("rejette un noteId malformé (pas un UUID)", () => {
    expect(() => parseUploadTokenPayload(validPayload({ noteId: "abc" }))).toThrow(
      /note/i,
    );
  });

  it("rejette un noteId absent", () => {
    const raw = JSON.stringify({ seq: 0, mimeType: "audio/webm", sizeBytes: 1024 });
    expect(() => parseUploadTokenPayload(raw)).toThrow(UploadValidationError);
  });

  it.each([-1, 1.5, "0"])("rejette un seq invalide (%s)", (seq) => {
    expect(() => parseUploadTokenPayload(validPayload({ seq }))).toThrow(
      /segment/i,
    );
  });

  it("rejette un mimeType hors liste blanche", () => {
    expect(() =>
      parseUploadTokenPayload(validPayload({ mimeType: "video/mp4" })),
    ).toThrow(/format audio/i);
  });

  it("rejette une taille au-dessus du plafond", () => {
    expect(() =>
      parseUploadTokenPayload(
        validPayload({ sizeBytes: MAX_SEGMENT_BYTES + 1 }),
      ),
    ).toThrow(/volumineux/i);
  });

  it("rejette une taille nulle ou négative", () => {
    expect(() => parseUploadTokenPayload(validPayload({ sizeBytes: 0 }))).toThrow(
      UploadValidationError,
    );
    expect(() =>
      parseUploadTokenPayload(validPayload({ sizeBytes: -10 })),
    ).toThrow(UploadValidationError);
  });

  it("accepte la taille exactement au plafond", () => {
    expect(() =>
      parseUploadTokenPayload(validPayload({ sizeBytes: MAX_SEGMENT_BYTES })),
    ).not.toThrow();
  });
});

describe("blobPathFor / audioPrefixForNote", () => {
  it("construit le chemin contractuel audio/{noteId}/{seq}", () => {
    expect(blobPathFor(NOTE_ID, 3)).toBe(`audio/${NOTE_ID}/3`);
  });

  it("construit le préfixe contractuel audio/{noteId}/", () => {
    expect(audioPrefixForNote(NOTE_ID)).toBe(`audio/${NOTE_ID}/`);
  });
});

describe("isValidNoteId", () => {
  it("accepte un UUID", () => {
    expect(isValidNoteId(NOTE_ID)).toBe(true);
  });

  it.each(["", "abc", "../../etc/passwd", `${NOTE_ID}/extra`])(
    "rejette %s",
    (candidate) => {
      expect(isValidNoteId(candidate)).toBe(false);
    },
  );
});
