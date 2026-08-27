import { put } from '@vercel/blob';
import { rateLimit } from '@/lib/rateLimit';
import { NextResponse } from 'next/server';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(request: Request) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'anon';
  if (!rateLimit('upload:' + ip, 20, 60_000)) {
    return NextResponse.json({ error: 'Trop de requêtes.' }, { status: 429, headers: CORS });
  }
  try {
    const form = await request.formData();
    const file = form.get('file') as File | null;
    const pathname = form.get('pathname') as string | null;
    if (!file || !pathname) {
      return NextResponse.json({ error: 'Fichier ou pathname manquant.' }, { status: 400, headers: CORS });
    }
    const blob = await put(pathname, file, { access: 'private', addRandomSuffix: true, contentType: file.type });
    return NextResponse.json({ url: blob.url }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Erreur upload.' }, { status: 500, headers: CORS });
  }
}
