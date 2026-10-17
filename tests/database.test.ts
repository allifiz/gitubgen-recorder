import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
const testRoot=mkdtempSync(tmpdir()+'/recorder-tests-');let dbIndex=0;
after(()=>rmSync(testRoot,{recursive:true,force:true}));
const newClient=()=>createClient({url:'file:'+testRoot+'/'+(dbIndex++)+'.db'});
import { createClient } from '@libsql/client';
import { getActiveProjectItemIds, getHistory, getRecorderState, recordStatuses, setRecorderState } from '../lib/database';

const item = (status: string, updatedAt: string) => ({
  projectItemId: 'PVTI_1', issueUrl: 'https://github.com/GO-Bimbel/api/issues/3908',
  title: 'Get Option Produk', repository: 'GO-Bimbel/api', number: 3908,
  status, statusUpdatedAt: updatedAt
});

test('baseline dicatat sekali lalu perubahan menjadi transition poll', async () => {
  const client = newClient();
  const baseline = await recordStatuses(client, [item('Todo', '2026-10-14T01:00:00Z')], '2026-10-14T01:00:10Z');
  const unchanged = await recordStatuses(client, [item('Todo', '2026-10-14T01:00:00Z')], '2026-10-14T01:01:00Z');
  const changed = await recordStatuses(client, [item('In Progress', '2026-10-14T01:01:42Z')], '2026-10-14T01:02:00Z');
  const history = await getHistory(client, [item('', '').issueUrl]);

  assert.deepEqual({ seeded: baseline.seeded, unchanged: unchanged.unchanged, changed: changed.changed }, { seeded: 1, unchanged: 1, changed: 1 });
  assert.equal(history.length, 2);
  assert.equal(history[1].previousStatus, 'Todo');
  assert.equal(history[1].newStatus, 'In Progress');
  assert.equal(history[1].occurredAt, '2026-10-14T01:01:42.000Z');
  assert.equal(history[1].detectedAt, '2026-10-14T01:02:00.000Z');
  client.close();
});

test('riwayat dapat difilter berdasarkan waktu', async () => {
  const client = newClient();
  await recordStatuses(client, [item('Todo', '2026-10-14T01:00:00Z')]);
  await recordStatuses(client, [item('In Progress', '2026-10-14T02:00:00Z')]);
  const history = await getHistory(client, [item('', '').issueUrl], '2026-10-14T01:30:00Z');
  assert.equal(history.length, 1);
  assert.equal(history[0].newStatus, 'In Progress');
  client.close();
});

test('batch besar tetap mencatat baseline dan perubahan dengan benar', async () => {
  const client = newClient();
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
  const client = newClient();
  await setRecorderState(client, 'cursor', 'abc');
  assert.equal(await getRecorderState(client, 'cursor'), 'abc');
  await setRecorderState(client, 'cursor', null);
  assert.equal(await getRecorderState(client, 'cursor'), null);
  client.close();
});

test('fast poll memilih status terbaru dan In Progress lama', async () => {
  const client = newClient();
  const oldTodo = { ...item('Todo', '2026-09-01T00:00:00Z'), projectItemId: 'PVTI_OLD_TODO', issueUrl: 'https://github.com/GO-Bimbel/api/issues/1' };
  const oldProgress = { ...item('In Progress', '2026-09-01T00:00:00Z'), projectItemId: 'PVTI_OLD_PROGRESS', issueUrl: 'https://github.com/GO-Bimbel/api/issues/2' };
  const recentDone = { ...item('Done', '2026-10-13T00:00:00Z'), projectItemId: 'PVTI_RECENT_DONE', issueUrl: 'https://github.com/GO-Bimbel/api/issues/3' };
  await recordStatuses(client, [oldTodo, oldProgress, recentDone]);

  const ids = await getActiveProjectItemIds(client, '2026-10-01T00:00:00Z');
  assert.deepEqual(new Set(ids), new Set(['PVTI_OLD_PROGRESS', 'PVTI_RECENT_DONE']));
  client.close();
});

test('schema memiliki index untuk query fast poll', async () => {
  const client = newClient();
  await recordStatuses(client, [item('Todo', '2026-10-14T01:00:00Z')]);
  const indexes = await client.execute('PRAGMA index_list(status_snapshot)');
  const names = new Set(indexes.rows.map(row => String(row.name)));
  const plan = await client.execute({
    sql: `EXPLAIN QUERY PLAN
      SELECT project_item_id
      FROM (
        SELECT project_item_id, status_updated_at FROM status_snapshot WHERE status_updated_at >= ?
        UNION
        SELECT project_item_id, status_updated_at FROM status_snapshot WHERE current_status = 'In Progress'
      )
      ORDER BY status_updated_at DESC
      LIMIT ?`,
    args: ['2026-10-01T00:00:00Z', 500]
  });
  const details = plan.rows.map(row => String(row.detail)).join('\n');

  assert.equal(names.has('idx_snapshot_status_updated'), true);
  assert.equal(names.has('idx_snapshot_current_status_updated'), true);
  assert.match(details, /idx_snapshot_status_updated/);
  assert.match(details, /idx_snapshot_current_status_updated/);
  client.close();
});

test('perbandingan snapshot tetap benar saat input kosong dan lebih dari satu batch', async () => {
  const client = newClient();
  const empty = await recordStatuses(client, []);
  const items = Array.from({ length: 450 }, (_, index) => ({
    ...item('Todo', '2026-10-14T01:00:00Z'),
    projectItemId: `PVTI_BATCH_${index}`,
    issueUrl: `https://github.com/GO-Bimbel/api/issues/${index + 1}`,
    number: index + 1
  }));
  await recordStatuses(client, items);
  const changed = await recordStatuses(client, [{
    ...items[449], status: 'In Progress', statusUpdatedAt: '2026-10-14T02:00:00Z'
  }]);

  assert.deepEqual(empty, {
    scanned: 0, seeded: 0, changed: 0, unchanged: 0, observations:0,stale:0,
    recordedAt: empty.recordedAt
  });
  assert.deepEqual({ changed: changed.changed, seeded: changed.seeded }, { changed: 1, seeded: 0 });
  client.close();
});
