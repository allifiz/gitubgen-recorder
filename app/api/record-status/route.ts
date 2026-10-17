import { randomUUID } from "node:crypto";
import { hasBearer } from "@/lib/auth";
import {
  database,
  ensureSchema,
  getActiveProjectItemIds,
  getRecorderState,
  recordStatuses,
  setRecorderState,
  acquireLease,
  releaseLease,
  newestItems,
  markActiveAttempt,
} from "@/lib/database";
import { cronSecret, githubConfig } from "@/lib/env";
import {
  fetchProjectStatusBatch,
  fetchProjectStatusesByIds,
} from "@/lib/github";
export const maxDuration = 30;
export async function GET(request: Request) {
  let client: ReturnType<typeof database> | undefined,
    owner: string | undefined;
  try {
    if (!hasBearer(request, cronSecret()))
      return Response.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    const started = Date.now(),
      config = githubConfig();
    client = database();
    await ensureSchema(client);
    owner = randomUUID();
    if (!(await acquireLease(client, owner)))
      return Response.json({
        ok: true,
        skipped: true,
        reason: "POLL_ALREADY_RUNNING",
      });
    const [cursor, activeIds] = await Promise.all([
      getRecorderState(client, "project_status_cursor"),
      getActiveProjectItemIds(
        client,
        new Date(started - 14 * 86400000).toISOString(),
        500,
      ),
    ]);
    const [activeItems, batch] = await Promise.all([
      fetchProjectStatusesByIds({
        token: config.token,
        projectItemIds: activeIds,
      }),
      fetchProjectStatusBatch({
        ...config,
        after: cursor,
        maxPages: 5,
        deadline: started + 22000,
      }),
    ]);
    await markActiveAttempt(client, activeIds);
    const githubMs = Date.now() - started,
      items = newestItems([...batch.items, ...activeItems]).filter(
        (i) => i.projectNumber === config.projectNumber,
      ),
      result = await recordStatuses(client, items);
    const now = new Date().toISOString();
    await setRecorderState(
      client,
      "project_status_cursor",
      batch.completedSweep ? null : batch.nextCursor,
    );
    await setRecorderState(client, "last_successful_poll", now);
    await setRecorderState(client, "last_poll_error", null);
    if (batch.completedSweep)
      await setRecorderState(client, "last_completed_sweep", now);
    const totalMs = Date.now() - started,
      metrics = {
        activeTracked: activeIds.length,
        activeScanned: activeItems.length,
        sweepScanned: batch.items.length,
        pages: batch.pages,
        sweepCompleted: batch.completedSweep,
        missingActive: activeIds.filter(
          (id) => !activeItems.some((i) => i.projectItemId === id),
        ).length,
      };
    console.info("record-status completed", {
      ...result,
      ...metrics,
      githubMs,
      totalMs,
    });
    return Response.json({
      ok: true,
      ...result,
      ...metrics,
      timing: { githubMs, databaseMs: totalMs - githubMs, totalMs },
    });
  } catch (e) {
    console.error("record-status failed", e);
    if (client)
      try {
        await setRecorderState(
          client,
          "last_poll_error",
          new Date().toISOString(),
        );
      } catch {}
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 },
    );
  } finally {
    if (client && owner)
      try {
        await releaseLease(client, owner);
      } catch {}
  }
}
