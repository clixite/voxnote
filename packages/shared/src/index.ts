export type SegmentStatus = 'queued' | 'uploading' | 'transcribing' | 'done' | 'failed';
export type NoteStatus = 'recording' | 'queued' | 'processing' | 'done' | 'error' | 'deleted';
export type Lang = 'fr' | 'nl' | 'en' | 'auto';

export interface AudioSegment {
  id: string;
  noteId: string;
  index: number;          // ordre de montage
  blobUrl?: string;
  mimeType: string;       // audio/mp4 (Safari) | audio/webm (Chrome)
  durationMs: number;
  status: SegmentStatus;
  transcript?: string;
  error?: string;
}

export interface Note {
  id: string;
  title: string;
  lang: Lang;
  segments: AudioSegment[];
  transcript: string;     // assemblage ordonné
  status: NoteStatus;
  createdAt: number;
  updatedAt: number;
}

export interface TranscribeRequest {
  segments: { blobUrl: string; mimeType: string; index: number }[];
}

export interface TranscribeResponse {
  status: NoteStatus;
}
