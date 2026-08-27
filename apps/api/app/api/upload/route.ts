import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextResponse } from 'next/server';

const ALLOWED = ['audio/mp4', 'audio/webm', 'audio/mpeg', 'audio/wav', 'audio/ogg'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(request: Request) {
  const body = (await request.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ALLOWED,
        maximumSizeInBytes: 30 * 1024 * 1024,
      }),
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(jsonResponse, { headers: CORS });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400, headers: CORS });
  }
}
