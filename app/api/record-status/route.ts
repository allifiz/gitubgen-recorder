import { hasBearer } from '@/lib/auth';
import { database, recordStatuses } from '@/lib/database';
import { cronSecret, githubConfig } from '@/lib/env';
import { fetchProjectStatuses } from '@/lib/github';

export async function GET(request: Request) {
  try {
    if (!hasBearer(request, cronSecret())) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    const startedAt = Date.now();
    const config = githubConfig();
    const items = await fetchProjectStatuses(config);
    const githubMs = Date.now() - startedAt;
    const result = await recordStatuses(database(), items);
    const totalMs = Date.now() - startedAt;
    console.info('record-status completed', { scanned: items.length, githubMs, databaseMs: totalMs - githubMs, totalMs });
    return Response.json({ ok: true, ...result, timing: { githubMs, databaseMs: totalMs - githubMs, totalMs } });
  } catch (error) {
    console.error('record-status failed', error);
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}
