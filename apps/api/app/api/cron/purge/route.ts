import { list, del } from '@vercel/blob';
import { NextResponse } from 'next/server';

export const maxDuration = 300;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(request: Request) {
  const auth = request.headers.get('authorization');
  const secret = process.env.CRON_SECRET;
  if (secret && auth !== 'Bearer ' + secret) {
    return NextResponse.json({ error: 'Non autorisé.' }, { status: 401, headers: CORS });
  }
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  let cursor: string | undefined;
  let purged = 0;
  try {
    do {
      const page = await list({ prefix: 'notes/', limit: 1000, cursor });
      for (const b of page.blobs) {
        if (b.uploadedAt.getTime() < cutoff) {
          await del(b.url).catch(() => {});
          purged++;
        }
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return NextResponse.json({ purged }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Erreur purge.' }, { status: 500, headers: CORS });
  }
}
