import type { NoteStatus } from '@voxnote/shared'

const ok: NoteStatus = 'done'

export async function GET() {
  return Response.json({ ok: true, service: 'voxnote-api', status: ok, time: Date.now() })
}
