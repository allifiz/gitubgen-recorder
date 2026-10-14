import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { getHistory, recordStatuses } from '../lib/database';

const item = (status: string, updatedAt: string) => ({
  projectItemId: 'PVTI_1', issueUrl: 'https://github.com/GO-Bimbel/api/issues/3908',
  title: 'Get Option Produk', repository: 'GO-Bimbel/api', number: 3908,
  status, statusUpdatedAt: updatedAt
});

test('baseline dicatat sekali lalu perubahan menjadi transition poll', async () => {
  const client = createClient({ url: 'file::memory:' });
  const baseline = await recordStatuses(client, [item('Todo', '2026-10-14T01:00:00Z')], '2026-10-14T01:00:10Z');
  const unchanged = await recordStatuses(client, [item('Todo', '2026-10-14T01:00:00Z')], '2026-10-14T01:01:00Z');
  const changed = await recordStatuses(client, [item('In Progress', '2026-10-14T01:01:42Z')], '2026-10-14T01:02:00Z');
  const history = await getHistory(client, [item('', '').issueUrl]);

  assert.deepEqual({ seeded: baseline.seeded, unchanged: unchanged.unchanged, changed: changed.changed }, { seeded: 1, unchanged: 1, changed: 1 });
  assert.equal(history.length, 2);
  assert.equal(history[1].previousStatus, 'Todo');
  assert.equal(history[1].newStatus, 'In Progress');
  assert.equal(history[1].occurredAt, '2026-10-14T01:01:42Z');
  assert.equal(history[1].detectedAt, '2026-10-14T01:02:00Z');
  client.close();
});

test('riwayat dapat difilter berdasarkan waktu', async () => {
  const client = createClient({ url: 'file::memory:' });
  await recordStatuses(client, [item('Todo', '2026-10-14T01:00:00Z')]);
  await recordStatuses(client, [item('In Progress', '2026-10-14T02:00:00Z')]);
  const history = await getHistory(client, [item('', '').issueUrl], '2026-10-14T01:30:00Z');
  assert.equal(history.length, 1);
  assert.equal(history[0].newStatus, 'In Progress');
  client.close();
});
