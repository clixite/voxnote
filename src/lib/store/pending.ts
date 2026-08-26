import type { SegmentStatus } from "@/types/notes";

/**
 * Statuts d'un segment qui n'a pas encore fini son aller vers le Blob :
 * jamais tenté (`local`), tenté mais retombé en erreur (`error`), ou laissé
 * `uploading` par un onglet mort avant la fin de l'upload (à reprendre au
 * démarrage — voir docs/ARCHITECTURE.md, la persistance IndexedDB avant upload
 * est ce qui garantit qu'un refresh ne perd que le segment en cours).
 *
 * `uploaded`, `transcribing` et `done` ont déjà atteint le Blob : ils ne sont
 * plus du ressort de la queue d'upload.
 */
export const PENDING_SEGMENT_STATUSES: readonly SegmentStatus[] = [
  "local",
  "uploading",
  "error",
];

const pendingSet: ReadonlySet<SegmentStatus> = new Set(
  PENDING_SEGMENT_STATUSES,
);

export function isPendingUploadStatus(status: SegmentStatus): boolean {
  return pendingSet.has(status);
}
