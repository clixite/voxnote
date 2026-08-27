export const API_URL: string = import.meta.env.VITE_API_URL ?? 'https://voxnote-api.vercel.app';

export function extFor(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'm4a';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mpeg')) return 'mp3';
  return 'bin';
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

export async function uploadSegment(pathname: string, blob: Blob, mimeType: string): Promise<string> {
  try {
    return await withRetry(async () => {
      const file = new File([blob], 'audio', { type: mimeType });
      const form = new FormData();
      form.append('file', file);
      form.append('pathname', pathname);
      const res = await fetch(API_URL + '/api/upload', { method: 'POST', body: form });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Upload de l'audio échoué.");
      return data.url ?? '';
    });
  } catch (e) {
    throw new Error('Upload audio échoué : ' + (e instanceof Error ? e.message : String(e)));
  }
}

export interface TranscribeSegmentInput {
  url: string;
  mimeType: string;
  index: number;
}

export async function transcribe(segments: TranscribeSegmentInput[], lang?: string): Promise<string> {
  try {
    return await withRetry(async () => {
      const res = await fetch(API_URL + '/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments, lang }),
      });
      const data = (await res.json()) as { transcript?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Erreur de transcription.');
      return data.transcript ?? '';
    });
  } catch (e) {
    throw new Error('Transcription échouée : ' + (e instanceof Error ? e.message : String(e)));
  }
}
