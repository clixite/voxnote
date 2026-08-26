import { afterEach, describe, expect, it } from "vitest";

import {
  clearActiveRecordingMarker,
  getTabId,
  isMarkerStale,
  isOwnMarker,
  readActiveRecordingMarker,
  STALE_THRESHOLD_MS,
  writeActiveRecordingMarker,
} from "./activeRecordingMarker";

describe("activeRecordingMarker", () => {
  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("ne renvoie rien tant qu'aucun marqueur n'a été écrit", () => {
    expect(readActiveRecordingMarker()).toBeUndefined();
  });

  it("relit un marqueur complet (noteId, tabId, updatedAt)", () => {
    const before = Date.now();
    writeActiveRecordingMarker("note-42");
    const marker = readActiveRecordingMarker();

    expect(marker?.noteId).toBe("note-42");
    expect(marker?.tabId).toBe(getTabId());
    expect(marker?.updatedAt).toBeGreaterThanOrEqual(before);
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

  it("ignore un contenu partiel (ancien format sans tabId/updatedAt)", () => {
    window.localStorage.setItem("voxnote:active-recording", JSON.stringify({ noteId: "note-1" }));
    expect(readActiveRecordingMarker()).toBeUndefined();
  });

  it("ignore un contenu bien formé mais aux types incorrects", () => {
    window.localStorage.setItem(
      "voxnote:active-recording",
      JSON.stringify({ noteId: 42, tabId: "t", updatedAt: "hier" }),
    );
    expect(readActiveRecordingMarker()).toBeUndefined();
  });

  describe("getTabId", () => {
    it("renvoie le même identifiant à chaque appel (persistant en sessionStorage)", () => {
      expect(getTabId()).toBe(getTabId());
    });

    it("change quand sessionStorage est vidé (simule un autre onglet)", () => {
      const first = getTabId();
      window.sessionStorage.clear();
      const second = getTabId();
      expect(second).not.toBe(first);
    });
  });

  describe("isOwnMarker", () => {
    it("reconnaît un marqueur écrit par cet onglet", () => {
      writeActiveRecordingMarker("note-1");
      const marker = readActiveRecordingMarker();
      expect(marker && isOwnMarker(marker)).toBe(true);
    });

    it("ne reconnaît pas un marqueur d'un autre tabId", () => {
      expect(isOwnMarker({ tabId: "un-autre-onglet" })).toBe(false);
    });
  });

  describe("isMarkerStale", () => {
    it("n'est pas périmé juste après écriture", () => {
      writeActiveRecordingMarker("note-1");
      const marker = readActiveRecordingMarker();
      expect(marker && isMarkerStale(marker)).toBe(false);
    });

    it("est périmé au-delà du seuil", () => {
      const now = Date.now();
      expect(isMarkerStale({ updatedAt: now - STALE_THRESHOLD_MS - 1 }, now)).toBe(true);
      expect(isMarkerStale({ updatedAt: now - STALE_THRESHOLD_MS + 1 }, now)).toBe(false);
    });
  });
});
