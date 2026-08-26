/**
 * Contrat de données partagé entre la capture audio, la persistance locale et
 * le pipeline de transcription. Figé par l'orchestrateur avant implémentation :
 * plusieurs agents codent contre ces types en parallèle.
 *
 * Voir docs/ARCHITECTURE.md pour le flux complet.
 */

/** Langue de transcription. `auto` = détection par le provider. */
export type Lang = "fr" | "nl" | "en";
export type LangSetting = Lang | "auto";

/**
 * Cycle de vie d'un segment. Un segment ne recule jamais, sauf retour de
 * `error` vers l'état précédent lors d'un réessai.
 *
 *   local → uploading → uploaded → transcribing → done
 *                  ↘ error ↙
 */
export type SegmentStatus =
  | "local"
  | "uploading"
  | "uploaded"
  | "transcribing"
  | "done"
  | "error";

/** État global d'une note, dérivé de l'état de ses segments. */
export type NoteStatus =
  | "recording"
  | "processing"
  | "done"
  | "partial"
  | "error";

export interface Note {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** Titre auto (date + premiers mots) ou saisi par l'utilisateur. */
  title: string;
  lang: LangSetting;
  /** Durée cumulée des segments fermés, en millisecondes. */
  durationMs: number;
  status: NoteStatus;
  /** Transcript assemblé et éventuellement édité par l'utilisateur. */
  text?: string;
  /** Vrai dès que l'utilisateur a modifié le texte à la main. */
  textEdited?: boolean;
}

export interface Segment {
  id: string;
  noteId: string;
  /** Ordre dans la note, à partir de 0. L'assemblage suit `seq`, jamais l'ordre d'arrivée. */
  seq: number;
  /**
   * Le fichier audio du segment, complet et décodable seul.
   * Voir `RECORDER_SEGMENT_MS` pour la raison du découpage.
   */
  blob: Blob;
  /** Détecté à l'exécution via MediaRecorder.isTypeSupported, jamais supposé. */
  mimeType: string;
  durationMs: number;
  status: SegmentStatus;
  /** URL du blob Vercel une fois l'upload terminé. */
  blobUrl?: string;
  /** Message d'erreur en français, affichable tel quel à l'utilisateur. */
  error?: string;
  /** Nombre de tentatives d'upload déjà effectuées. */
  attempts: number;
}

export interface Transcript {
  noteId: string;
  seq: number;
  text: string;
  provider: string;
  createdAt: number;
}

/**
 * Durée visée d'un segment. Borne la perte en cas de crash et reste très en
 * dessous de la limite de taille par fichier des API de transcription.
 */
export const RECORDER_SEGMENT_MS = 5 * 60 * 1000;

/** Plafond de durée par note (garde-fou coût, cf. docs/RISQUES.md). */
export const NOTE_MAX_DURATION_MS = 2 * 60 * 60 * 1000;

export interface CreateNoteInput {
  lang: LangSetting;
  title?: string;
}

export interface AppendSegmentInput {
  noteId: string;
  seq: number;
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

/**
 * Accès à la persistance locale. Implémentation IndexedDB en production, double
 * en mémoire dans les tests : aucun consommateur ne dépend directement d'`idb`.
 */
export interface NoteStore {
  createNote(input: CreateNoteInput): Promise<Note>;
  getNote(id: string): Promise<Note | undefined>;
  /** Antéchronologique : la plus récente d'abord. */
  listNotes(): Promise<Note[]>;
  updateNote(id: string, patch: Partial<Omit<Note, "id">>): Promise<Note>;
  /** Supprime la note ET ses segments ET ses transcripts, atomiquement. */
  deleteNote(id: string): Promise<void>;

  /**
   * Écrit un segment. Ne touche NI `Note.durationMs` NI `Note.status` : le
   * stockage ne dérive rien. C'est l'appelant (le hook d'enregistrement, puis
   * la queue d'upload) qui met la note à jour explicitement via `updateNote`.
   * Une couche de persistance qui calcule des états métier devient impossible
   * à raisonner dès qu'un second écrivain apparaît.
   */
  appendSegment(input: AppendSegmentInput): Promise<Segment>;
  /** Triés par `seq` croissant. */
  listSegments(noteId: string): Promise<Segment[]>;
  updateSegment(
    id: string,
    patch: Partial<Omit<Segment, "id" | "noteId" | "seq">>,
  ): Promise<Segment>;
  /**
   * Tous les segments encore à uploader, toutes notes confondues, par ancienneté.
   *
   * « En attente » couvre `local`, `uploading` ET `error`. Inclure `uploading`
   * est délibéré : un segment laissé dans cet état est un upload interrompu par
   * un refresh ou un crash, donc précisément ce que la queue doit reprendre.
   * L'exclure créerait un trou permanent dans la note — l'inverse exact du
   * critère « zéro perte » de la Phase 2.
   */
  listPendingSegments(): Promise<Segment[]>;

  putTranscript(transcript: Transcript): Promise<void>;
  listTranscripts(noteId: string): Promise<Transcript[]>;
}
