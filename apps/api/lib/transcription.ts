export interface TranscriptionProvider {
  transcribe(audio: Blob, opts: { mimeType: string; lang?: string }): Promise<string>;
}

function audioExt(mimeType: string): string {
  const mt = mimeType.split(';')[0].toLowerCase();
  if (mt.includes('mp4')) return 'm4a';
  if (mt.includes('mpeg')) return 'mp3';
  if (mt.includes('ogg')) return 'ogg';
  if (mt.includes('wav')) return 'wav';
  return 'webm';
}

class GroqProvider implements TranscriptionProvider {
  constructor(private apiKey: string) {}

  async transcribe(audio: Blob, opts: { mimeType: string; lang?: string }): Promise<string> {
    const ext = audioExt(opts.mimeType);
    const form = new FormData();
    form.append('file', audio, 'audio.' + ext);
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'json');
    if (opts.lang && opts.lang !== 'auto') form.append('language', opts.lang);

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.apiKey },
      body: form,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error('Transcription Groq échouée (' + res.status + ') : ' + errText.slice(0, 200));
    }
    const data = (await res.json()) as { text?: string };
    return data.text ?? '';
  }
}

// Extrait un texte diarisé depuis la réponse Gladia (parsing défensif).
function extractDiarizedText(poll: any): string {
  const t = poll?.result?.transcription ?? poll?.data?.transcription ?? poll?.transcription;
  const utts = Array.isArray(t?.utterances) ? t.utterances : [];
  if (utts.length) {
    return utts
      .map((u: any) => {
        const text = (u?.text ?? '').trim();
        if (!text) return '';
        const sp = u?.speaker;
        return sp !== undefined ? `[Locuteur ${sp + 1}] ${text}` : text;
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof t?.full_transcript === 'string' && t.full_transcript.trim()) return t.full_transcript.trim();
  return '';
}

class GladiaProvider implements TranscriptionProvider {
  constructor(private apiKey: string) {}

  async transcribe(audio: Blob, opts: { mimeType: string; lang?: string }): Promise<string> {
    const headers = { 'x-gladia-key': this.apiKey };
    const ext = audioExt(opts.mimeType);

    // 1) Upload du fichier vers Gladia
    const upForm = new FormData();
    upForm.append('audio', audio, 'audio.' + ext);
    const upRes = await fetch('https://api.gladia.io/v2/upload', { method: 'POST', headers, body: upForm });
    const upData = (await upRes.json()) as any;
    if (!upRes.ok) throw new Error('Gladia upload (' + upRes.status + ') : ' + JSON.stringify(upData).slice(0, 200));
    const audioUrl = upData.audio_url;
    if (!audioUrl) throw new Error('Gladia : URL audio introuvable.');

    // 2) Lancement de la transcription (diarisation)
    const body: any = { audio_url: audioUrl, diarization: true };
    if (opts.lang && opts.lang !== 'auto') body.language_config = { languages: [opts.lang] };
    const init = await fetch('https://api.gladia.io/v2/transcription', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const job = (await init.json()) as any;
    if (!init.ok) throw new Error('Gladia init (' + init.status + ') : ' + JSON.stringify(job).slice(0, 200));
    const id = job.id ?? job.transcription_id;
    if (!id) throw new Error('Gladia : id manquant.');

    // 3) Polling du résultat
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const res = await fetch('https://api.gladia.io/v2/transcription/' + id, { headers });
      const poll = (await res.json()) as any;
      if (poll?.status === 'done') return extractDiarizedText(poll);
      if (poll?.status === 'error') throw new Error('Gladia : ' + (poll?.error?.message ?? 'erreur de transcription'));
    }
    throw new Error('Gladia : délai dépassé.');
  }
}

export function getProvider(): TranscriptionProvider {
  const name = process.env.TRANSCRIBE_PROVIDER ?? 'groq';
  if (name === 'groq') {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error('GROQ_API_KEY non configurée sur le serveur.');
    return new GroqProvider(key);
  }
  if (name === 'gladia') {
    const key = process.env.GLADIA_API_KEY;
    if (!key) throw new Error('GLADIA_API_KEY non configurée sur le serveur.');
    return new GladiaProvider(key);
  }
  throw new Error('Provider inconnu : ' + name);
}
