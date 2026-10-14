import { hasBearer } from '@/lib/auth';
import { database, getActiveProjectItemIds, getRecorderState, recordStatuses, setRecorderState } from '@/lib/database';
import { cronSecret, githubConfig } from '@/lib/env';
import { fetchProjectStatusBatch, fetchProjectStatusesByIds } from '@/lib/github';

const CURSOR_KEY = 'project_status_cursor';
const ACTIVE_WINDOW_DAYS = 14;
const ACTIVE_LIMIT = 500;

export async function GET(request: Request) {
  try {
    if (!hasBearer(request, cronSecret())) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    const startedAt = Date.now();
    const config = githubConfig();
    const client = database();
    const recentSince = new Date(startedAt - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const [cursor, activeIds] = await Promise.all([
      getRecorderState(client, CURSOR_KEY),
      getActiveProjectItemIds(client, recentSince, ACTIVE_LIMIT)
    ]);
    const [activeItems, batch] = await Promise.all([
      fetchProjectStatusesByIds({ token: config.token, projectItemIds: activeIds }),
      fetchProjectStatusBatch({ ...config, after: cursor, maxPages: 5 })
    ]);
    const githubMs = Date.now() - startedAt;
    const uniqueItems = [...new Map(
      [...batch.items, ...activeItems].map(item => [item.projectItemId, item])
    ).values()];
    const result = await recordStatuses(client, uniqueItems);
    await setRecorderState(client, CURSOR_KEY, batch.completedSweep ? null : batch.nextCursor);
    const totalMs = Date.now() - startedAt;
    console.info('record-status completed', {
      scanned: uniqueItems.length, activeTracked: activeIds.length, activeScanned: activeItems.length,
      sweepScanned: batch.items.length, pages: batch.pages, sweepCompleted: batch.completedSweep,
      githubMs, databaseMs: totalMs - githubMs, totalMs
    });
    return Response.json({
      ok: true, ...result, activeTracked: activeIds.length, activeScanned: activeItems.length,
      sweepScanned: batch.items.length, pages: batch.pages, sweepCompleted: batch.completedSweep,
      timing: { githubMs, databaseMs: totalMs - githubMs, totalMs }
    });
  } catch (error) {
    console.error('record-status failed', error);
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}
