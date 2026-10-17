import { hasBearer } from "@/lib/auth";
import { database, getHistory, readiness } from "@/lib/database";
import { apiSecret } from "@/lib/env";
import { parseHistoryRequest } from "@/lib/history-request";
export async function POST(request: Request) {
  try {
    if (!hasBearer(request, apiSecret()))
      return Response.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    let input;
    try {
      input = parseHistoryRequest(await request.json());
    } catch (e) {
      return Response.json(
        { ok: false, error: e instanceof Error ? e.message : "Invalid input" },
        { status: 400 },
      );
    }
    const client = database(),
      events = await getHistory(
        client,
        input.issueUrls,
        input.from,
        input.to,
        input.includeContext,
        true,
      ),
      health = await readiness(client);
    const context = events.filter(
        (e) => !e.observationOnly && input.from && e.occurredAt < input.from,
      ),
      history = events.filter(
        (e) =>
          !e.observationOnly && (!input.from || e.occurredAt >= input.from),
      ),
      observations = events.filter((e) => e.observationOnly),
      covered = new Set(events.flatMap((e) => e.requestedUrls));
    return Response.json({
      ok: true,
      history,
      context,
      observations,
      coverage: {
        requested: input.issueUrls.length,
        processed: input.issueUrls.length,
        missing: input.issueUrls.filter((u) => !covered.has(u)),
        truncated: false,
        complete: health.fresh,
        range: {
          from: input.from || null,
          to: input.to || null,
          endExclusive: true,
        },
        ...health,
        pollingSeconds: 60,
        transientBackfill: false,
      },
    });
  } catch (e) {
    console.error("status-history failed", e);
    return Response.json(
      { ok: false, error: "History belum siap. Periksa health Recorder." },
      { status: 503 },
    );
  }
}
