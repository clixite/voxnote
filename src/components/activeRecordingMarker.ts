/**
 * Trace, côté client uniquement, de la note actuellement en cours
 * d'enregistrement — écrite pendant que `useRecorder` est en état
 * `recording`/`paused`, effacée à un arrêt propre (`stopped`).
 *
 * Pourquoi ce n'est pas déductible du `NoteStore` seul : `Note.status` reste
 * `"recording"` indéfiniment tant que la queue d'upload (hors périmètre de ce
 * ticket, pas encore implémentée) n'a pas fait progresser la note — voir le
 * commentaire sur `NoteStore.appendSegment` dans `src/types/notes.ts`. Une
 * note normalement arrêtée par l'utilisateur et une note abandonnée par un
 * crash ont donc exactement la même forme en base. Ce marqueur local est ce
 * qui distingue les deux : s'il est encore présent au montage, la dernière
 * session connue ne s'est pas terminée proprement.
 *
 * `localStorage` est partagé entre TOUS les onglets d'une même origine : un
 * marqueur qui ne contiendrait que le `noteId` ne distinguerait pas « cet
 * onglet a repris cette note » de « un autre onglet est en train de
 * l'enregistrer en ce moment ». Sans cette distinction, deux onglets peuvent
 * démarrer un moteur sur la même note en parallèle : les deux numérotent
 * leurs segments à partir du même `seq`, et le second écrase l'audio du
 * premier dans Vercel Blob (chemin `audio/{noteId}/{seq}`) — voir le rapport
 * du ticket B4. Le marqueur porte donc aussi :
 *  - `tabId` : identifiant stable de CET onglet, stocké en `sessionStorage`
 *    (scope par onglet, contrairement à `localStorage`) — il survit à un
 *    refresh du même onglet mais diffère d'un onglet réellement différent ;
 *  - `updatedAt` : rafraîchi périodiquement pendant l'enregistrement (voir
 *    `HEARTBEAT_INTERVAL_MS`), pour distinguer un autre onglet encore vivant
 *    d'un autre onglet mort (crashé, fermé) dont le marqueur est devenu
 *    périmé (voir `STALE_THRESHOLD_MS`).
 *
 * Seuils retenus et pourquoi : les onglets d'arrière-plan sont throttlés par
 * les navigateurs (Chrome peut réduire un `setInterval` à environ une
 * exécution par minute une fois l'onglet caché). `HEARTBEAT_INTERVAL_MS` à
 * 20 s reste très en dessous de ce pire cas en conditions normales (onglet
 * au premier plan, ce qui est l'usage principal de VoxNote — enregistrer en
 * marchant, téléphone en main). `STALE_THRESHOLD_MS` à 90 s est choisi
 * au-delà de ce pire cas de throttling (~60 s) avec une marge d'environ 30 s
 * pour absorber la gigue : un onglet vivant mais mis en arrière-plan n'est
 * donc jamais déclaré mort à tort. En contrepartie, après un crash réel,
 * l'attente avant qu'un autre onglet puisse proposer de reprendre la note
 * est bornée à ce même seuil — un peu moins d'une minute et demie dans le
 * pire cas, largement acceptable face au risque de corruption évité.
 *
 * Best-effort : `localStorage`/`sessionStorage` peuvent être indisponibles
 * (navigation privée, quota, contexte sans DOM) ou leur contenu corrompu.
 * Dans tous ces cas, on se dégrade silencieusement — la reprise après
 * refresh est un confort pour l'utilisateur, jamais une garantie de données
 * (celle-ci vient de l'écriture immédiate de chaque segment en IndexedDB,
 * déjà assurée par `RecorderEngine`).
 */
const STORAGE_KEY = "voxnote:active-recording";
const TAB_ID_KEY = "voxnote:tab-id";

/** Fréquence de rafraîchissement du marqueur pendant une session active. */
export const HEARTBEAT_INTERVAL_MS = 20_000;
/** Au-delà de cet âge, le marqueur est considéré comme laissé par un onglet mort. */
export const STALE_THRESHOLD_MS = 90_000;

export interface ActiveRecordingMarker {
  noteId: string;
  /** Identifiant de l'onglet qui détenait la note à la dernière écriture. */
  tabId: string;
  /** `Date.now()` de la dernière écriture (initiale ou heartbeat). */
  updatedAt: number;
}

function getLocalStorage(): Storage | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function getSessionStorage(): Storage | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Repli pour un environnement sans crypto.randomUUID : suffisant pour
  // distinguer des onglets entre eux, pas un identifiant cryptographique.
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Identifiant stable de cet onglet, persistant en `sessionStorage` : le même
 * après un refresh de cet onglet, différent d'un onglet réellement distinct
 * (sessionStorage n'est pas partagé entre onglets, sauf duplication explicite
 * d'onglet dans certains navigateurs — limite connue et acceptée).
 * Sans stockage disponible, un identifiant frais est renvoyé à chaque appel :
 * dégrade vers « toujours considéré comme un autre onglet », jamais l'inverse.
 */
export function getTabId(): string {
  const storage = getSessionStorage();
  if (!storage) return generateId();
  try {
    const existing = storage.getItem(TAB_ID_KEY);
    if (existing) return existing;
    const created = generateId();
    storage.setItem(TAB_ID_KEY, created);
    return created;
  } catch {
    return generateId();
  }
}

function isValidMarker(value: unknown): value is ActiveRecordingMarker {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.noteId === "string" &&
    typeof candidate.tabId === "string" &&
    typeof candidate.updatedAt === "number"
  );
}

export function readActiveRecordingMarker(): ActiveRecordingMarker | undefined {
  const storage = getLocalStorage();
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isValidMarker(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Écrit ou rafraîchit le marqueur pour CET onglet — appelé au démarrage et à chaque heartbeat. */
export function writeActiveRecordingMarker(noteId: string): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    const marker: ActiveRecordingMarker = { noteId, tabId: getTabId(), updatedAt: Date.now() };
    storage.setItem(STORAGE_KEY, JSON.stringify(marker));
  } catch {
    // Quota dépassé ou stockage bloqué : rien de plus à faire ici.
  }
}

export function clearActiveRecordingMarker(): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // idem
  }
}

/** `true` si ce marqueur a été écrit par CET onglet (même sessionStorage). */
export function isOwnMarker(marker: Pick<ActiveRecordingMarker, "tabId">): boolean {
  return marker.tabId === getTabId();
}

/** `true` si le marqueur n'a plus été rafraîchi depuis `STALE_THRESHOLD_MS` : son onglet est probablement mort. */
export function isMarkerStale(
  marker: Pick<ActiveRecordingMarker, "updatedAt">,
  now: number = Date.now(),
): boolean {
  return now - marker.updatedAt > STALE_THRESHOLD_MS;
}
