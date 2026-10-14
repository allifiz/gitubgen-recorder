import { hasBearer } from '@/lib/auth';
import { database, recordStatuses } from '@/lib/database';
import { cronSecret, githubConfig } from '@/lib/env';
import { fetchProjectStatuses } from '@/lib/github';

export async function GET(request: Request) {
  try {
    if (!hasBearer(request, cronSecret())) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    const config = githubConfig();
    const items = await fetchProjectStatuses(config);
    const result = await recordStatuses(database(), items);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    console.error('record-status failed', error);
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}
