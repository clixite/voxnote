import { NextResponse } from 'next/server';
import { del, get } from '@vercel/blob';
import { getProvider } from '@/lib/transcription';
import { rateLimit } from '@/lib/rateLimit';

export const maxDuration = 300;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

interface SegmentInput {
  url: string;
  mimeType: string;
  index: number;
}

const ALLOWED = ['audio/mp4', 'audio/webm', 'audio/mpeg', 'audio/wav', 'audio/ogg'];

export async function POST(request: Request) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'anon';
  if (!rateLimit('transcribe:' + ip, 10, 60_000)) {
    return NextResponse.json({ error: 'Trop de requêtes, réessayez dans un instant.' }, { status: 429, headers: CORS });
  }
  let body: { segments?: SegmentInput[]; lang?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON invalide.' }, { status: 400, headers: CORS });
  }

  const segments = body.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    return NextResponse.json({ error: 'Aucun segment reçu.' }, { status: 400, headers: CORS });
  }
  const baseMime = (t: string) => t.split(';')[0].trim();
  for (const s of segments) {
    if (!s.url || !s.mimeType || !ALLOWED.includes(baseMime(s.mimeType))) {
      return NextResponse.json({ error: 'Segment invalide.' }, { status: 400, headers: CORS });
    }
  }

  try {
    const provider = getProvider();
    const ordered = [...segments].sort((a, b) => a.index - b.index);
    const texts = await Promise.all(
      ordered.map(async (seg) => {
        const result = await get(seg.url, { access: 'private' });
        if (!result || !result.stream) throw new Error('Lecture du segment ' + seg.index + ' impossible.');
        const audioBlob = await new Response(result.stream).blob();
        return provider.transcribe(audioBlob, { mimeType: seg.mimeType, lang: body.lang });
      }),
    );

    await Promise.all(segments.map((s) => del(s.url).catch(() => {})));

    return NextResponse.json({ transcript: texts.join('\n') }, { headers: CORS });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Erreur de transcription.' },
      { status: 502, headers: CORS },
    );
  }
}
