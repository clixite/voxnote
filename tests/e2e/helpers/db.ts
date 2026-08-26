import type { Page } from "@playwright/test";

/**
 * Nom de la base applicative (`src/lib/store/indexeddb.ts`). Ce helper est un
 * simple OBSERVATEUR en lecture : il ne connaît et n'impose aucun numéro de
 * version de schéma — la version évolue avec les migrations (voir
 * `NOTES_DB_VERSION`, déjà passé à 2 pour l'index unique `(noteId, seq)` du
 * BLOQUANT B4), et un helper qui coderait un numéro en dur casserait à
 * chaque migration future, comme celui-ci l'a fait une première fois.
 * `readDbSnapshot` n'assume que le contrat public stable (noms des stores et
 * des champs, voir `src/types/notes.ts`), jamais la structure interne
 * (index, keyPath) ni le numéro de version.
 */
const DB_NAME = "voxnote";

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
 * Ouvre SANS préciser de version (`indexedDB.open(dbName)`) : ça connecte à
 * la version courante, quelle qu'elle soit, sans jamais déclencher
 * `onupgradeneeded` sur une base qui existe déjà. Coder un numéro de
 * version en dur ici serait faux dès la prochaine migration applicative
 * (déjà arrivé une fois : la version est passée à 2 pendant que ce fichier
 * en attendait 1, `VersionError` immédiat).
 *
 * Si la base n'existe pas encore (aucun enregistrement démarré dans ce
 * test), on renvoie un instantané vide SANS jamais appeler `indexedDB.open`
 * dessus : l'ouvrir la créerait avec un numéro de version, ce qui
 * empêcherait ensuite l'application elle-même de la considérer comme
 * nouvelle et d'exécuter sa vraie migration (`onupgradeneeded` ne se
 * redéclenche que si la version demandée augmente par rapport à l'existant).
 * `indexedDB.databases()` permet de vérifier l'existence sans effet de bord.
 */
export async function readDbSnapshot(page: Page): Promise<DbSnapshot> {
  return page.evaluate(async (dbName): Promise<DbSnapshot> => {
    const empty: DbSnapshot = { notes: [], segments: [] };

    if (typeof indexedDB.databases === "function") {
      const existing = await indexedDB.databases();
      if (!existing.some((entry) => entry.name === dbName)) {
        return empty;
      }
    }

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onupgradeneeded = () => {
        // Ne devrait jamais se produire : soit `databases()` a confirmé que
        // la base existe déjà, soit `open()` sans version se contente de
        // connecter à l'existant. Si ça arrive quand même (navigateur sans
        // `databases()`, ou base réellement absente), mieux vaut échouer
        // explicitement que fabriquer un schéma qui ne correspond pas
        // forcément à celui, réel, de l'application.
        req.transaction?.abort();
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error as DOMException);
      req.onblocked = () => reject(new Error("Ouverture IndexedDB bloquée par une autre connexion."));
    });

    function getAll<T>(storeName: string): Promise<T[]> {
      return new Promise((resolve, reject) => {
        // Store absent : dégradation explicite en liste vide, jamais un
        // crash — une future migration pourrait renommer/réorganiser sans
        // que ce helper ait à le prévoir.
        if (!db.objectStoreNames.contains(storeName)) {
          resolve([]);
          return;
        }
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
  }, DB_NAME);
}
