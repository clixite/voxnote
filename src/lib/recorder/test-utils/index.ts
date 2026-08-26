export { FakeMediaRecorder, type FakeMediaRecorderState } from "./fake-media-recorder";
export { createFakeMediaStream, type FakeMediaStreamTrack } from "./fake-media-stream";

/**
 * `createMemoryNoteStore` (src/lib/store/memory.ts) EST le double `NoteStore`
 * à utiliser dans ce module et dans tout nouveau test : il est vérifié contre
 * la même batterie de tests de contrat que la vraie implémentation IndexedDB
 * (voir src/lib/store/contract.test.ts), là où l'ancien double maison de ce
 * dossier (`fake-note-store.ts`, supprimé) en divergeait silencieusement
 * (`listPendingSegments`, `appendSegment` sur note inconnue...) — exactement
 * le scénario qui aurait fait passer au vert des tests de la queue d'upload
 * de la Phase 3 sur un comportement que la vraie base ne reproduit pas.
 *
 * Réexporté ici sous le nom `createFakeNoteStore`, le temps que
 * src/components/RecorderScreen.test.tsx (hors périmètre de ce module) soit
 * migré vers l'import direct — c'est littéralement `createMemoryNoteStore`,
 * pas une nouvelle implémentation : aucune divergence possible.
 */
export { createMemoryNoteStore, createMemoryNoteStore as createFakeNoteStore } from "@/lib/store/memory";
