import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createMemoryNoteStore } from "@/lib/store/memory";
import type { QueueSegmentContext } from "@/lib/upload/queue";

import UploadQueueSection from "./UploadQueueSection";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Un léger délai réel (pas juste une microtâche) force React à committer
// l'état intermédiaire "syncing" avant que la file ne retombe à "idle" :
// sans lui, un traitement trop rapide peut sauter l'état observable entre
// deux rendus, ce qui n'a rien à voir avec le comportement testé ici.
function fakeTransport() {
  const uploadSegment = vi.fn(async (ctx: QueueSegmentContext) => {
    await delay(10);
    return `https://blob.example/${ctx.noteId}/${ctx.seq}`;
  });
  const transcribeSegment = vi.fn(async () => {
    await delay(10);
    return { text: "bonjour", provider: "groq" as const };
  });
  return { uploadSegment, transcribeSegment };
}

describe("UploadQueueSection", () => {
  it("affiche la progression de la note suivie une fois ses segments traités", async () => {
    const store = createMemoryNoteStore();
    const note = await store.createNote({ lang: "fr" });
    await store.updateNote(note.id, { status: "processing" });
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["audio"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });
    const { uploadSegment, transcribeSegment } = fakeTransport();

    render(
      <UploadQueueSection
        store={store}
        noteId={note.id}
        segmentCount={1}
        onAnnounce={vi.fn()}
        uploadSegment={uploadSegment}
        transcribeSegment={transcribeSegment}
        isOnline={() => true}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("upload-progress")).toHaveTextContent("1 / 1"));
  });

  it("annonce la fin de la transcription au passage syncing -> idle", async () => {
    const store = createMemoryNoteStore();
    const note = await store.createNote({ lang: "fr" });
    await store.updateNote(note.id, { status: "processing" });
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["audio"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });
    const { uploadSegment, transcribeSegment } = fakeTransport();
    const onAnnounce = vi.fn();

    render(
      <UploadQueueSection
        store={store}
        noteId={note.id}
        segmentCount={1}
        onAnnounce={onAnnounce}
        uploadSegment={uploadSegment}
        transcribeSegment={transcribeSegment}
        isOnline={() => true}
      />,
    );

    await waitFor(() => expect(onAnnounce).toHaveBeenCalledWith("Transcription terminée."));
  });

  it("réveille la file quand segmentCount augmente", async () => {
    const store = createMemoryNoteStore();
    const note = await store.createNote({ lang: "fr" });
    await store.updateNote(note.id, { status: "processing" });
    const { uploadSegment, transcribeSegment } = fakeTransport();

    const { rerender } = render(
      <UploadQueueSection
        store={store}
        noteId={note.id}
        segmentCount={0}
        onAnnounce={vi.fn()}
        uploadSegment={uploadSegment}
        transcribeSegment={transcribeSegment}
        isOnline={() => true}
      />,
    );

    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["audio"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });
    rerender(
      <UploadQueueSection
        store={store}
        noteId={note.id}
        segmentCount={1}
        onAnnounce={vi.fn()}
        uploadSegment={uploadSegment}
        transcribeSegment={transcribeSegment}
        isOnline={() => true}
      />,
    );

    await waitFor(() => expect(uploadSegment).toHaveBeenCalled());
  });
});
