import type { Page } from "@playwright/test";

/**
 * Nom de base et schéma mirroir de `src/lib/store/indexeddb.ts`. Dupliqué ici
 * volontairement : `page.evaluate` ne peut sérialiser que la fonction qu'on
 * lui passe (pas d'import de code applicatif dans le contexte de la page), et
 * lire l'IndexedDB réelle du navigateur — plutôt que de faire confiance à ce
 * que `RecorderScreen` affiche — est le seul moyen de prouver la persistance
 * (voir le ticket P2-5). Si le schéma de `indexeddb.ts` change, ce fichier
 * doit être mis à jour en conséquence.
 */
const DB_NAME = "voxnote";
const DB_VERSION = 1;

/**
 * Supprime entièrement la base IndexedDB de l'app et vide le localStorage
 * (où vit le marqueur de reprise, voir `activeRecordingMarker.ts`), puis
 * recharge la page pour repartir avec un `RecorderScreen` qui n'a encore
 * rien ouvert. Chaque test Playwright a déjà son propre contexte navigateur
 * isolé (donc son propre IndexedDB) ; cet appel explicite est une garantie
 * supplémentaire demandée par le ticket contre toute fuite d'état, et le
 * seul moyen fiable de repartir de zéro pour des tests qui réutiliseraient
 * la même page (ex. plusieurs `test.step` dans un scénario long).
 */
export async function resetAppState(page: Page): Promise<void> {
  await page.evaluate(
    (dbName) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase(dbName);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error as DOMException);
        // "blocked" signifie une connexion encore ouverte ailleurs (peu
        // probable ici, une seule page par test) : on n'attend pas
        // indéfiniment, la suppression finira par s'appliquer.
        req.onblocked = () => resolve();
      }),
    DB_NAME,
  );
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
}

export interface DbNoteSnapshot {
  id: string;
  createdAt: number;
  durationMs: number;
  status: string;
}

export interface DbSegmentSnapshot {
  id: string;
  noteId: string;
  seq: number;
  durationMs: number;
  mimeType: string;
  status: string;
  /** Taille du Blob audio, en octets : un `Blob` ne traverse pas `page.evaluate`, seule sa taille en sort. */
  size: number;
}

export interface DbSnapshot {
  notes: DbNoteSnapshot[];
  segments: DbSegmentSnapshot[];
}

/**
 * Lit directement l'IndexedDB du navigateur (API native, sans dépendre
 * d'`idb` ni du code applicatif) : la seule preuve réelle de persistance,
 * par opposition à une simple lecture de ce que l'écran affiche.
 *
 * Ouvre avec le même nom/version que l'application. Si la base n'existe pas
 * encore (aucun enregistrement démarré dans ce test), la création à la volée
 * ci-dessous reproduit le schéma de `indexeddb.ts` — nécessaire pour ne
 * jamais heurter une base sans object stores, ce qui empêcherait
 * durablement l'application de fonctionner dans la suite du test (une base
 * ouverte une fois en version 1 sans upgrade ultérieur ne re-déclenche
 * jamais `onupgradeneeded`).
 */
export async function readDbSnapshot(page: Page): Promise<DbSnapshot> {
  return page.evaluate(async ({ dbName, dbVersion }): Promise<DbSnapshot> => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, dbVersion);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains("notes")) {
          const notes = database.createObjectStore("notes", { keyPath: "id" });
          notes.createIndex("by-createdAt", "createdAt");
        }
        if (!database.objectStoreNames.contains("segments")) {
          const segments = database.createObjectStore("segments", { keyPath: "id" });
          segments.createIndex("by-noteId", "noteId");
          segments.createIndex("by-status", "status");
        }
        if (!database.objectStoreNames.contains("transcripts")) {
          const transcripts = database.createObjectStore("transcripts", {
            keyPath: ["noteId", "seq"],
          });
          transcripts.createIndex("by-noteId", "noteId");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error as DOMException);
    });

    function getAll<T>(storeName: string): Promise<T[]> {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result as T[]);
        request.onerror = () => reject(request.error as DOMException);
      });
    }

    interface RawNote {
      id: string;
      createdAt: number;
      durationMs: number;
      status: string;
    }
    interface RawSegment {
      id: string;
      noteId: string;
      seq: number;
      durationMs: number;
      mimeType: string;
      status: string;
      blob: Blob;
    }

    const [rawNotes, rawSegments] = await Promise.all([
      getAll<RawNote>("notes"),
      getAll<RawSegment>("segments"),
    ]);

    db.close();

    return {
      notes: rawNotes.map((note) => ({
        id: note.id,
        createdAt: note.createdAt,
        durationMs: note.durationMs,
        status: note.status,
      })),
      segments: rawSegments
        .map((segment) => ({
          id: segment.id,
          noteId: segment.noteId,
          seq: segment.seq,
          durationMs: segment.durationMs,
          mimeType: segment.mimeType,
          status: segment.status,
          size: segment.blob ? segment.blob.size : 0,
        }))
        .sort((a, b) => a.seq - b.seq),
    };
  }, { dbName: DB_NAME, dbVersion: DB_VERSION });
}
