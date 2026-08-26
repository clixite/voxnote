import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DocumentVisibilityLike, WakeLockLike, WakeLockSentinelLike } from "@/hooks/useWakeLock";
import {
  createFakeMediaStream,
  createFakeNoteStore,
  FakeMediaRecorder,
} from "@/lib/recorder/test-utils";

import {
  clearActiveRecordingMarker,
  HEARTBEAT_INTERVAL_MS,
  readActiveRecordingMarker,
  writeActiveRecordingMarker,
} from "./activeRecordingMarker";
import RecorderScreen from "./RecorderScreen";

const ACTIVE_RECORDING_KEY = "voxnote:active-recording";

function writeForeignMarker(noteId: string, ageMs: number) {
  window.localStorage.setItem(
    ACTIVE_RECORDING_KEY,
    JSON.stringify({ noteId, tabId: "un-autre-onglet", updatedAt: Date.now() - ageMs }),
  );
}

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

  it("permission refusée : erreur en role alert avec le conseil de réactivation du micro", async () => {
    // Le texte exact du message vient de src/lib/recorder/errors.ts et peut
    // être reformulé sans préavis (tutoiement en cours côté hook) : on
    // n'assertionne que sur ce qui nous appartient — role="alert" et le
    // conseil affiché en fonction du errorCode.
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
    expect(alert).toHaveTextContent(/autorise le micro/i);
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

  it("reprendre continue réellement la note interrompue : la numérotation repart de l'existant, pas de zéro", async () => {
    setSupported("audio/webm;codecs=opus");
    const store = createFakeNoteStore();
    const note = await store.createNote({ lang: "fr" });
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["x"]),
      mimeType: "audio/webm",
      durationMs: 4000,
    });
    writeActiveRecordingMarker(note.id);

    render(
      <RecorderScreen
        store={store}
        getUserMedia={vi.fn(async () => createFakeMediaStream())}
        isTypeSupported={(t) => FakeMediaRecorder.isTypeSupported(t)}
        createMediaRecorder={fakeMediaRecorderFactory()}
        wakeLock={createWorkingWakeLock()}
        documentRef={fakeDocument}
        segmentMs={1000}
      />,
    );

    // La détection de la note interrompue est asynchrone (lecture du store) :
    // on attend son affichage avec de vrais minuteurs avant de passer aux
    // minuteurs simulés pour la rotation de segment ci-dessous (un `waitFor`
    // sous minuteurs simulés resterait bloqué, son polling interne ne serait
    // jamais réveillé).
    const resumeButton = await screen.findByRole("button", { name: /reprendre l'enregistrement/i });
    vi.useFakeTimers();

    await act(async () => {
      resumeButton.click();
    });

    // Aucune nouvelle note créée : le compteur affiche déjà 1 (le segment
    // repris), pas 0, dès que l'enregistrement redémarre.
    expect(screen.getByRole("button", { name: /arrêter/i })).toBeInTheDocument();
    expect(screen.getByTestId("segment-status")).toHaveTextContent(/1 segment enregistré/i);
    expect(screen.queryByText(/non terminé/i)).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByTestId("segment-status")).toHaveTextContent(/2 segments enregistrés/i);

    const allSegments = await store.listSegments(note.id);
    expect(allSegments).toHaveLength(2);
    expect(allSegments[0]?.seq).toBe(0);
    expect(allSegments[1]?.seq).toBe(1);
    const notesInStore = await store.listNotes();
    expect(notesInStore).toHaveLength(1); // toujours la même note, aucun doublon créé.

    clearActiveRecordingMarker();
  });

  it("note disparue entre-temps : la reprise échoue et s'affiche comme n'importe quelle autre erreur", async () => {
    setSupported("audio/webm;codecs=opus");
    const store = createFakeNoteStore();
    const note = await store.createNote({ lang: "fr" });
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["x"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });
    writeActiveRecordingMarker(note.id);

    render(
      <RecorderScreen
        store={store}
        isTypeSupported={(t) => FakeMediaRecorder.isTypeSupported(t)}
        wakeLock={createWorkingWakeLock()}
        documentRef={fakeDocument}
      />,
    );

    const resumeButton = await screen.findByRole("button", { name: /reprendre l'enregistrement/i });

    // La note disparaît avant que l'utilisateur ne clique (ex. purge RGPD).
    await store.deleteNote(note.id);

    await act(async () => {
      resumeButton.click();
    });

    const alert = await screen.findByRole("alert");
    // Aucun conseil pour ce code (pas de réponse fiable) : seul le message du
    // hook doit apparaître, jamais un conseil inventé.
    expect(alert.querySelectorAll("p")).toHaveLength(1);

    clearActiveRecordingMarker();
  });

  it("ne signale rien au montage si aucune note n'a été laissée active", () => {
    const store = createFakeNoteStore();
    render(<RecorderScreen store={store} wakeLock={createWorkingWakeLock()} documentRef={fakeDocument} />);
    expect(screen.queryByText(/non terminé/i)).not.toBeInTheDocument();
  });

  it("B4 — un marqueur frais d'un AUTRE onglet empêche la reprise (évite les seq dupliqués)", async () => {
    const store = createFakeNoteStore();
    const note = await store.createNote({ lang: "fr" });
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["x"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });
    writeForeignMarker(note.id, 0); // heartbeat qui vient d'avoir lieu : onglet manifestement vivant.

    render(<RecorderScreen store={store} wakeLock={createWorkingWakeLock()} documentRef={fakeDocument} />);

    expect(await screen.findByText(/autre onglet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reprendre l'enregistrement/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/non terminé/i)).not.toBeInTheDocument();
  });

  it("B4/S3 — un marqueur frais d'un autre onglet protège aussi une note SANS AUCUN SEGMENT (régression)", async () => {
    // Le piège précis qui a régressé : un onglet qui vient de démarrer n'a
    // aucun segment fermé pendant ses cinq premières minutes (la durée d'un
    // cycle). Si la garde multi-onglets était évaluée APRÈS la suppression
    // de coquille vide (S3), cette note fraîchement démarrée dans l'onglet A
    // serait vue comme une coquille vide par l'onglet B et supprimée —
    // détruisant tout l'audio en cours d'enregistrement dans A. La garde
    // "autre onglet" doit donc être évaluée EN PREMIER, avant toute
    // suppression, quel que soit le nombre de segments.
    const store = createFakeNoteStore();
    const note = await store.createNote({ lang: "fr" });
    // Aucun appendSegment : exactement la situation d'un enregistrement tout
    // juste démarré ailleurs, avant la fermeture de son premier segment.
    writeForeignMarker(note.id, 0); // heartbeat qui vient d'avoir lieu : onglet A manifestement vivant.
    const deleteSpy = vi.spyOn(store, "deleteNote");

    render(<RecorderScreen store={store} wakeLock={createWorkingWakeLock()} documentRef={fakeDocument} />);

    expect(await screen.findByText(/autre onglet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reprendre l'enregistrement/i })).not.toBeInTheDocument();

    // L'assertion qui compte vraiment : la note doit toujours exister, pas
    // seulement "un bandeau s'affiche quelque part".
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await store.getNote(note.id)).toBeDefined();
    expect(await store.listNotes()).toHaveLength(1);
  });

  it("B4 — un marqueur périmé d'un autre onglet (mort) redevient reprenable normalement", async () => {
    const store = createFakeNoteStore();
    const note = await store.createNote({ lang: "fr" });
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["x"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });
    writeForeignMarker(note.id, 5 * 60 * 1000); // 5 min sans heartbeat : bien au-delà du seuil de péremption.

    render(<RecorderScreen store={store} wakeLock={createWorkingWakeLock()} documentRef={fakeDocument} />);

    expect(await screen.findByRole("button", { name: /reprendre l'enregistrement/i })).toBeInTheDocument();
    expect(screen.queryByText(/autre onglet/i)).not.toBeInTheDocument();
  });

  it("B4 — le refresh du même onglet (marqueur propre) reste reprenable même s'il n'a pas encore de heartbeat récent", async () => {
    // Cas nominal à ne surtout pas régresser : cet onglet a écrit son propre
    // marqueur puis a rechargé la page. getTabId() (sessionStorage) renvoie
    // le même identifiant qu'avant le refresh : le marqueur lui appartient,
    // peu importe son âge.
    const store = createFakeNoteStore();
    const note = await store.createNote({ lang: "fr" });
    await store.appendSegment({
      noteId: note.id,
      seq: 0,
      blob: new Blob(["x"]),
      mimeType: "audio/webm",
      durationMs: 1000,
    });
    writeActiveRecordingMarker(note.id); // écrit avec le vrai tabId de cet environnement de test.

    render(<RecorderScreen store={store} wakeLock={createWorkingWakeLock()} documentRef={fakeDocument} />);

    expect(await screen.findByRole("button", { name: /reprendre l'enregistrement/i })).toBeInTheDocument();
    expect(screen.queryByText(/autre onglet/i)).not.toBeInTheDocument();
  });

  it("S3 — supprime silencieusement une note interrompue sans aucun segment, sans bandeau", async () => {
    const store = createFakeNoteStore();
    const note = await store.createNote({ lang: "fr" });
    writeActiveRecordingMarker(note.id); // marqueur normal, mais 0 segment jamais fermé.
    const deleteSpy = vi.spyOn(store, "deleteNote");

    render(<RecorderScreen store={store} wakeLock={createWorkingWakeLock()} documentRef={fakeDocument} />);

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith(note.id));
    expect(screen.queryByText(/non terminé/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(await store.listNotes()).toHaveLength(0);
  });

  it("rafraîchit périodiquement le marqueur pendant l'enregistrement (heartbeat)", async () => {
    vi.useFakeTimers();
    setSupported("audio/webm;codecs=opus");
    const store = createFakeNoteStore();

    render(
      <RecorderScreen
        store={store}
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

    const afterStart = readActiveRecordingMarker();
    expect(afterStart).toBeDefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    });

    const afterHeartbeat = readActiveRecordingMarker();
    expect(afterHeartbeat?.noteId).toBe(afterStart?.noteId);
    expect(afterHeartbeat!.updatedAt).toBeGreaterThan(afterStart!.updatedAt);
  });
});
