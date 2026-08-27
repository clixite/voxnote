export async function GET() {
  return Response.json({ ok: true, service: 'voxnote-api', time: Date.now() })
}
