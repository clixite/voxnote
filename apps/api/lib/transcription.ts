export interface TranscriptionProvider {
  transcribe(audio: Blob, opts: { mimeType: string; lang?: string }): Promise<string>;
}

class GroqProvider implements TranscriptionProvider {
  constructor(private apiKey: string) {}

  async transcribe(audio: Blob, opts: { mimeType: string; lang?: string }): Promise<string> {
    const mt = opts.mimeType.split(';')[0].toLowerCase();
    let ext = 'webm';
    if (mt.includes('mp4')) ext = 'm4a';
    else if (mt.includes('mpeg')) ext = 'mp3';
    else if (mt.includes('ogg')) ext = 'ogg';
    else if (mt.includes('wav')) ext = 'wav';
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

export function getProvider(): TranscriptionProvider {
  const name = process.env.TRANSCRIBE_PROVIDER ?? 'groq';
  if (name === 'groq') {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error('GROQ_API_KEY non configurée sur le serveur.');
    return new GroqProvider(key);
  }
  throw new Error('Provider inconnu : ' + name);
}
