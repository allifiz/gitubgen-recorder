import { hasBearer } from '@/lib/auth';
import { database, getHistory } from '@/lib/database';
import { apiSecret } from '@/lib/env';

const validGitHubUrl = (value: unknown): value is string =>
  typeof value === 'string' && /^https:\/\/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+\/?$/.test(value);

export async function POST(request: Request) {
  try {
    if (!hasBearer(request, apiSecret())) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    const body = await request.json() as { issueUrls?: unknown[]; from?: string; to?: string };
    const issueUrls = [...new Set((body.issueUrls || []).filter(validGitHubUrl))].slice(0, 250);
    if (!issueUrls.length) return Response.json({ ok: false, error: 'issueUrls wajib diisi.' }, { status: 400 });
    const history = await getHistory(database(), issueUrls, body.from, body.to);
    return Response.json({ ok: true, history });
  } catch (error) {
    console.error('status-history failed', error);
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}
