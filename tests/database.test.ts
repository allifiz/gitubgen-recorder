import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { getActiveProjectItemIds, getHistory, getRecorderState, recordStatuses, setRecorderState } from '../lib/database';

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

test('batch besar tetap mencatat baseline dan perubahan dengan benar', async () => {
  const client = createClient({ url: 'file::memory:' });
  const items = Array.from({ length: 120 }, (_, index) => ({
    ...item('Todo', `2026-10-14T01:${String(index % 60).padStart(2, '0')}:00Z`),
    projectItemId: `PVTI_${index}`, issueUrl: `https://github.com/GO-Bimbel/api/issues/${index + 1}`,
    number: index + 1
  }));
  const baseline = await recordStatuses(client, items);
  const next = items.map((current, index) => index === 50
    ? { ...current, status: 'In Progress', statusUpdatedAt: '2026-10-14T03:00:00Z' }
    : current);
  const changed = await recordStatuses(client, next);

  assert.equal(baseline.seeded, 120);
  assert.deepEqual({ changed: changed.changed, unchanged: changed.unchanged }, { changed: 1, unchanged: 119 });
  assert.equal((await getHistory(client, [items[50].issueUrl])).length, 2);
  client.close();
});

test('cursor polling dapat disimpan dan direset', async () => {
  const client = createClient({ url: 'file::memory:' });
  await setRecorderState(client, 'cursor', 'abc');
  assert.equal(await getRecorderState(client, 'cursor'), 'abc');
  await setRecorderState(client, 'cursor', null);
  assert.equal(await getRecorderState(client, 'cursor'), null);
  client.close();
});

test('fast poll memilih status terbaru dan In Progress lama', async () => {
  const client = createClient({ url: 'file::memory:' });
  const oldTodo = { ...item('Todo', '2026-09-01T00:00:00Z'), projectItemId: 'PVTI_OLD_TODO', issueUrl: 'https://github.com/GO-Bimbel/api/issues/1' };
  const oldProgress = { ...item('In Progress', '2026-09-01T00:00:00Z'), projectItemId: 'PVTI_OLD_PROGRESS', issueUrl: 'https://github.com/GO-Bimbel/api/issues/2' };
  const recentDone = { ...item('Done', '2026-10-13T00:00:00Z'), projectItemId: 'PVTI_RECENT_DONE', issueUrl: 'https://github.com/GO-Bimbel/api/issues/3' };
  await recordStatuses(client, [oldTodo, oldProgress, recentDone]);

  const ids = await getActiveProjectItemIds(client, '2026-10-01T00:00:00Z');
  assert.deepEqual(new Set(ids), new Set(['PVTI_OLD_PROGRESS', 'PVTI_RECENT_DONE']));
  client.close();
});
