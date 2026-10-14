import { hasBearer } from '@/lib/auth';
import { database, getRecorderState, recordStatuses, setRecorderState } from '@/lib/database';
import { cronSecret, githubConfig } from '@/lib/env';
import { fetchProjectStatusBatch } from '@/lib/github';

const CURSOR_KEY = 'project_status_cursor';

export async function GET(request: Request) {
  try {
    if (!hasBearer(request, cronSecret())) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    const startedAt = Date.now();
    const config = githubConfig();
    const client = database();
    const cursor = await getRecorderState(client, CURSOR_KEY);
    const batch = await fetchProjectStatusBatch({ ...config, after: cursor, maxPages: 5 });
    const githubMs = Date.now() - startedAt;
    const result = await recordStatuses(client, batch.items);
    await setRecorderState(client, CURSOR_KEY, batch.completedSweep ? null : batch.nextCursor);
    const totalMs = Date.now() - startedAt;
    console.info('record-status completed', {
      scanned: batch.items.length, pages: batch.pages, sweepCompleted: batch.completedSweep,
      githubMs, databaseMs: totalMs - githubMs, totalMs
    });
    return Response.json({
      ok: true, ...result, pages: batch.pages, sweepCompleted: batch.completedSweep,
      timing: { githubMs, databaseMs: totalMs - githubMs, totalMs }
    });
  } catch (error) {
    console.error('record-status failed', error);
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}
