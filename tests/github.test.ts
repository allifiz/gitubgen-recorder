import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchProjectStatuses } from '../lib/github';

test('mengambil status Project V2 dan timestamp field Status', async () => {
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({
    data: { organization: { projectV2: { items: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{
        id: 'PVTI_1',
        content: { number: 3908, title: 'Get Option Produk', url: 'https://github.com/GO-Bimbel/api/issues/3908', repository: { nameWithOwner: 'GO-Bimbel/api' } },
        fieldValueByName: { name: 'In Progress', updatedAt: '2026-10-14T02:15:00Z' }
      }]
    } } } }
  }), { status: 200 });
  const rows = await fetchProjectStatuses({ token: 'test', org: 'GO-Bimbel', projectNumber: 11, fetchImpl: fakeFetch });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'In Progress');
  assert.equal(rows[0].statusUpdatedAt, '2026-10-14T02:15:00Z');
});

test('mengikuti pagination Project V2', async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: { organization: { projectV2: { items: {
      pageInfo: { hasNextPage: calls === 1, endCursor: calls === 1 ? 'cursor-1' : null },
      nodes: []
    } } } } }), { status: 200 });
  };
  await fetchProjectStatuses({ token: 'test', org: 'GO-Bimbel', projectNumber: 11, fetchImpl: fakeFetch });
  assert.equal(calls, 2);
});
