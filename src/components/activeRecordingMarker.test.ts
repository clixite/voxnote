import { afterEach, describe, expect, it } from "vitest";

import {
  clearActiveRecordingMarker,
  readActiveRecordingMarker,
  writeActiveRecordingMarker,
} from "./activeRecordingMarker";

describe("activeRecordingMarker", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("ne renvoie rien tant qu'aucun marqueur n'a été écrit", () => {
    expect(readActiveRecordingMarker()).toBeUndefined();
  });

  it("relit exactement ce qui a été écrit", () => {
    writeActiveRecordingMarker("note-42");
    expect(readActiveRecordingMarker()).toEqual({ noteId: "note-42" });
  });

  it("efface le marqueur", () => {
    writeActiveRecordingMarker("note-42");
    clearActiveRecordingMarker();
    expect(readActiveRecordingMarker()).toBeUndefined();
  });

  it("ignore un contenu corrompu sans lever d'exception", () => {
    window.localStorage.setItem("voxnote:active-recording", "{ pas du json");
    expect(readActiveRecordingMarker()).toBeUndefined();
  });

  it("ignore un contenu bien formé mais sans noteId exploitable", () => {
    window.localStorage.setItem("voxnote:active-recording", JSON.stringify({ noteId: 42 }));
    expect(readActiveRecordingMarker()).toBeUndefined();
  });
});
