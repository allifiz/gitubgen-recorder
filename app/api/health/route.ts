import { database, readiness } from "@/lib/database";
export async function GET(request: Request) {
  if (new URL(request.url).searchParams.get("check") === "live")
    return Response.json({ ok: true, live: true });
  try {
    const state = await readiness(database());
    return Response.json(
      {
        ok: state.ready && state.fresh,
        live: true,
        ...state,
        pollingSeconds: 60,
      },
      { status: state.ready && state.fresh ? 200 : 503 },
    );
  } catch {
    return Response.json(
      { ok: false, live: true, ready: false, fresh: false },
      { status: 503 },
    );
  }
}
