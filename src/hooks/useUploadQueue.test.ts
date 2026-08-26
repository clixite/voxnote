import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createMemoryNoteStore } from "@/lib/store/memory";
import { ApiRequestError } from "@/lib/upload/errors";
import type { QueueSegmentContext } from "@/lib/upload/queue";

import { useUploadQueue, type WindowOnlineLike } from "./useUploadQueue";

function createFakeWindow(): WindowOnlineLike & { emitOnline: () => void } {
  const listeners = new Set<() => void>();
  return {
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    emitOnline() {
      listeners.forEach((l) => l());
    },
  };
}

async function makeProcessingNote(store: ReturnType<typeof createMemoryNoteStore>) {
  const note = await store.createNote({ lang: "fr" });
  await store.updateNote(note.id, { status: "processing" });
  return note;
}

describe("useUploadQueue", () => {
  it("démarre la file au montage et reflète l'avancement d'une note", async () => {
    const store = createMemoryNoteStore();
    const note = await makeProcessingNote(store);
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["audio"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    const uploadSegment = vi.fn(async (ctx: QueueSegmentContext) => `https://blob.example/${ctx.noteId}/${ctx.seq}`);
    const transcribeSegment = vi.fn(async () => ({ text: "bonjour", provider: "groq" }));

    const { result } = renderHook(() =>
      useUploadQueue({
        store,
        noteId: note.id,
        uploadSegment,
        transcribeSegment,
        isOnline: () => true,
        windowRef: createFakeWindow(),
      }),
    );

    await waitFor(() => {
      expect(result.current.noteProgress?.transcribedCount).toBe(1);
    });

    expect(result.current.globalStatus).toBe("idle");
    expect(result.current.noteProgress).toEqual({
      total: 1,
      uploadedCount: 1,
      transcribedCount: 1,
      errorSegments: [],
    });
  });

  it("relance la file dès l'événement 'online'", async () => {
    const store = createMemoryNoteStore();
    const note = await makeProcessingNote(store);
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["audio"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    const uploadSegment = vi.fn(async (ctx: QueueSegmentContext) => `https://blob.example/${ctx.noteId}/${ctx.seq}`);
    const transcribeSegment = vi.fn(async () => ({ text: "bonjour", provider: "groq" }));
    const fakeWindow = createFakeWindow();
    let online = false;

    const { result } = renderHook(() =>
      useUploadQueue({
        store,
        noteId: note.id,
        uploadSegment,
        transcribeSegment,
        isOnline: () => online,
        windowRef: fakeWindow,
      }),
    );

    await waitFor(() => expect(result.current.globalStatus).toBe("offline"));
    expect(uploadSegment).not.toHaveBeenCalled();

    online = true;
    act(() => {
      fakeWindow.emitOnline();
    });

    await waitFor(() => {
      expect(result.current.noteProgress?.transcribedCount).toBe(1);
    });
  });

  it("retrySegment relance immédiatement un segment en erreur", async () => {
    const store = createMemoryNoteStore();
    const note = await makeProcessingNote(store);
    const segment = await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["audio"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });

    let attempts = 0;
    const uploadSegment = vi.fn(async (ctx: QueueSegmentContext) => {
      attempts += 1;
      if (attempts === 1) {
        throw new ApiRequestError({
          error: "AUDIO_UNREADABLE",
          message: "Ce fichier est invalide.",
          retryable: false,
        });
      }
      return `https://blob.example/${ctx.noteId}/${ctx.seq}`;
    });
    const transcribeSegment = vi.fn(async () => ({ text: "bonjour", provider: "groq" }));

    const { result } = renderHook(() =>
      useUploadQueue({
        store,
        noteId: note.id,
        uploadSegment,
        transcribeSegment,
        isOnline: () => true,
        windowRef: createFakeWindow(),
      }),
    );

    await waitFor(() => {
      expect(result.current.noteProgress?.errorSegments).toHaveLength(1);
    });

    act(() => {
      result.current.retrySegment(segment.id);
    });

    await waitFor(() => {
      expect(result.current.noteProgress?.transcribedCount).toBe(1);
    });
    expect(uploadSegment).toHaveBeenCalledTimes(2);
  });
});
