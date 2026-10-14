export async function GET() {
  return Response.json({ ok: true, service: 'gitubgen-recorder', time: new Date().toISOString() });
}
