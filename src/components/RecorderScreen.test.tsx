import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DocumentVisibilityLike, WakeLockLike, WakeLockSentinelLike } from "@/hooks/useWakeLock";
import {
  createFakeMediaStream,
  createFakeNoteStore,
  FakeMediaRecorder,
} from "@/lib/recorder/test-utils";

import { clearActiveRecordingMarker, writeActiveRecordingMarker } from "./activeRecordingMarker";
import RecorderScreen from "./RecorderScreen";

function setSupported(...types: string[]) {
  FakeMediaRecorder.resetForTests();
  FakeMediaRecorder.supportedTypes = new Set(types);
}

function createWorkingWakeLock(): WakeLockLike {
  return {
    async request() {
      const sentinel: WakeLockSentinelLike = {
        released: false,
        async release() {
          (sentinel as { released: boolean }).released = true;
        },
        addEventListener() {},
        removeEventListener() {},
      };
      return sentinel;
    },
  };
}

const fakeDocument: DocumentVisibilityLike = {
  visibilityState: "visible",
  addEventListener() {},
  removeEventListener() {},
};

function fakeMediaRecorderFactory() {
  return (stream: MediaStream, options: MediaRecorderOptions) =>
    new FakeMediaRecorder(stream, options) as unknown as MediaRecorder;
}

describe("RecorderScreen", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it("démarre l'enregistrement au tap et le nom accessible du bouton principal change", async () => {
    setSupported("audio/webm;codecs=opus");
    const store = createFakeNoteStore();
    const getUserMedia = vi.fn(async () => createFakeMediaStream());

    render(
      <RecorderScreen
        store={store}
        getUserMedia={getUserMedia}
        isTypeSupported={(t) => FakeMediaRecorder.isTypeSupported(t)}
        createMediaRecorder={fakeMediaRecorderFactory()}
        wakeLock={createWorkingWakeLock()}
        documentRef={fakeDocument}
      />,
    );

    expect(screen.getByRole("button", { name: /enregistrer/i })).toBeInTheDocument();

    await act(async () => {
      screen.getByRole("button", { name: /enregistrer/i }).click();
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /arrêter/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /^enregistrer$/i })).not.toBeInTheDocument();
  });

  it("le bouton pause fige le compteur, reprendre le relance", async () => {
    vi.useFakeTimers();
    setSupported("audio/webm;codecs=opus");
    const store = createFakeNoteStore();
    const getUserMedia = vi.fn(async () => createFakeMediaStream());

    render(
      <RecorderScreen
        store={store}
        getUserMedia={getUserMedia}
        isTypeSupported={(t) => FakeMediaRecorder.isTypeSupported(t)}
        createMediaRecorder={fakeMediaRecorderFactory()}
        wakeLock={createWorkingWakeLock()}
        documentRef={fakeDocument}
        now={() => Date.now()}
      />,
    );

    await act(async () => {
      screen.getByRole("button", { name: /enregistrer/i }).click();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    await act(async () => {
      screen.getByRole("button", { name: /pause/i }).click();
      await Promise.resolve();
    });

    const frozen = screen.getByText(/^\d{2}:\d{2}$/).textContent;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(screen.getByText(/^\d{2}:\d{2}$/).textContent).toBe(frozen);
    expect(screen.getByRole("button", { name: /reprendre/i })).toBeInTheDocument();
  });

  it("permission refusée : message français affiché en role alert", async () => {
    setSupported("audio/webm;codecs=opus");
    const store = createFakeNoteStore();
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("refusé", "NotAllowedError");
    });

    render(
      <RecorderScreen
        store={store}
        getUserMedia={getUserMedia}
        isTypeSupported={(t) => FakeMediaRecorder.isTypeSupported(t)}
        wakeLock={createWorkingWakeLock()}
        documentRef={fakeDocument}
      />,
    );

    await act(async () => {
      screen.getByRole("button", { name: /enregistrer/i }).click();
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/microphone refusé/i);
  });

  it("affiche le bandeau wake lock quand le verrou est indisponible, l'absente quand il fonctionne", async () => {
    setSupported("audio/webm;codecs=opus");
    const store = createFakeNoteStore();

    const { unmount } = render(
      <RecorderScreen
        store={store}
        getUserMedia={vi.fn(async () => createFakeMediaStream())}
        isTypeSupported={(t) => FakeMediaRecorder.isTypeSupported(t)}
        createMediaRecorder={fakeMediaRecorderFactory()}
        wakeLock={undefined}
        documentRef={fakeDocument}
      />,
    );

    await act(async () => {
      screen.getByRole("button", { name: /enregistrer/i }).click();
    });

    await waitFor(() => expect(screen.getByText(/garde l.?écran allumé/i)).toBeInTheDocument());
    unmount();

    setSupported("audio/webm;codecs=opus");
    const store2 = createFakeNoteStore();
    render(
      <RecorderScreen
        store={store2}
        getUserMedia={vi.fn(async () => createFakeMediaStream())}
        isTypeSupported={(t) => FakeMediaRecorder.isTypeSupported(t)}
        createMediaRecorder={fakeMediaRecorderFactory()}
        wakeLock={createWorkingWakeLock()}
        documentRef={fakeDocument}
      />,
    );

    await act(async () => {
      screen.getByRole("button", { name: /enregistrer/i }).click();
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /arrêter/i })).toBeInTheDocument(),
    );
    expect(screen.queryByText(/garde l.?écran allumé/i)).not.toBeInTheDocument();
  });

  it("le nombre de segments affiché suit la réalité du store", async () => {
    vi.useFakeTimers();
    setSupported("audio/webm;codecs=opus");
    const store = createFakeNoteStore();
    const getUserMedia = vi.fn(async () => createFakeMediaStream());

    render(
      <RecorderScreen
        store={store}
        getUserMedia={getUserMedia}
        isTypeSupported={(t) => FakeMediaRecorder.isTypeSupported(t)}
        createMediaRecorder={fakeMediaRecorderFactory()}
        wakeLock={createWorkingWakeLock()}
        documentRef={fakeDocument}
        segmentMs={1000}
      />,
    );

    await act(async () => {
      screen.getByRole("button", { name: /enregistrer/i }).click();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // Sous minuteurs simulés, `waitFor` (qui repose sur de vrais minuteurs
    // pour son polling) resterait bloqué : l'assertion directe suffit, l'état
    // React est déjà flush à la sortie du bloc `act` ci-dessus.
    expect(screen.getByTestId("segment-status")).toHaveTextContent(/1 segment enregistré/i);
    const segmentsInStore = await store.listSegments((await store.listNotes())[0]!.id);
    expect(segmentsInStore).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.getByTestId("segment-status")).toHaveTextContent(/2 segments enregistrés/i);
  });

  it("signale au montage une note non terminée trouvée en IndexedDB, et permet de la terminer", async () => {
    const store = createFakeNoteStore();
    const note = await store.createNote({ lang: "auto" });
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["x"]),
      mimeType: "audio/webm",
      durationMs: 4000,
    });
    writeActiveRecordingMarker(note.id);

    render(<RecorderScreen store={store} wakeLock={createWorkingWakeLock()} documentRef={fakeDocument} />);

    expect(await screen.findByText(/non terminé/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reprendre l'enregistrement/i })).toBeInTheDocument();
    const finishButton = screen.getByRole("button", { name: /terminer cette note/i });

    await act(async () => {
      finishButton.click();
    });

    expect(screen.queryByText(/non terminé/i)).not.toBeInTheDocument();

    clearActiveRecordingMarker();
  });

  it("ne signale rien au montage si aucune note n'a été laissée active", () => {
    const store = createFakeNoteStore();
    render(<RecorderScreen store={store} wakeLock={createWorkingWakeLock()} documentRef={fakeDocument} />);
    expect(screen.queryByText(/non terminé/i)).not.toBeInTheDocument();
  });
});
