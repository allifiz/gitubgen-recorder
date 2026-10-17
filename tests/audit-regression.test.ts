import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import {
  ensureSchema,
  recordStatuses,
  getHistory,
  getActiveProjectItemIds,
  acquireLease,
  releaseLease,
  newestItems,
  readiness,
  setRecorderState,
} from "../lib/database";
import { parseHistoryRequest } from "../lib/history-request";
const root = mkdtempSync(tmpdir() + "/recorder-regress-");
let index = 0;
after(() => rmSync(root, { recursive: true, force: true }));
const db = () => createClient({ url: `file:${root}/${index++}.db` });
const url = "https://github.com/GO-Bimbel/api/issues/1",
  moved = "https://github.com/GO-Bimbel/new/issues/2";
const item = (
  status = "In Progress",
  time = "2026-10-15T02:00:00Z",
  extra = {},
) => ({
  projectItemId: "PVTI_1",
  issueNodeId: "I_1",
  projectNumber: 11,
  issueUrl: url,
  title: "Test",
  repository: "GO-Bimbel/api",
  number: 1,
  status,
  statusUpdatedAt: time,
  ...extra,
});
test("F17 same status changed timestamp adalah observasi; tidak backfill toggle singkat", async () => {
  const c = db();
  await recordStatuses(c, [item("Todo")]);
  const out = await recordStatuses(c, [item("Todo", "2026-10-15T02:00:40Z")]);
  assert.equal(out.observations, 1);
  assert.equal(out.changed, 0);
  const h = await getHistory(c, [url]);
  assert.equal(h.length, 1);
  const all = await getHistory(c, [url], undefined, undefined, false, true);
  assert.equal(all.length, 2);
  assert.equal(all[1].observationOnly, true);
  assert.equal(all[1].gap, true);
  c.close();
});
test("F18 transfer URL memakai identitas item sama dan history alias menyatu", async () => {
  const c = db();
  await recordStatuses(c, [item()]);
  await recordStatuses(c, [
    item("Ready to Review", "2026-10-15T03:00:00Z", {
      issueUrl: moved,
      repository: "GO-Bimbel/new",
      number: 2,
    }),
  ]);
  const a = await getHistory(c, [url]),
    b = await getHistory(c, [moved]);
  assert.equal(a.length, 2);
  assert.equal(b.length, 2);
  assert.equal(a[0].issueUrl, moved);
  assert.equal((await c.execute("SELECT * FROM current_items")).rows.length, 1);
  assert.equal((await c.execute("SELECT * FROM issue_aliases")).rows.length, 2);
  c.close();
});
test("F18 migrasi preserve legacy dan pilih snapshot transfer terbaru", async () => {
  const c = db();
  await ensureSchema(c);
  await c.execute("DELETE FROM recorder_state WHERE key='schema_version'");
  for (const [u, status, time] of [
    [url, "In Progress", "2026-10-15T02:00:00Z"],
    [moved, "Ready to Review", "2026-10-15T03:00:00Z"],
  ])
    await c.execute({
      sql: "INSERT INTO status_snapshot VALUES(?,?,?,?,?,?,?,?)",
      args: [
        u,
        "PVTI_TRANSFER",
        "Legacy",
        "GO-Bimbel/api",
        1,
        status,
        time,
        time,
      ],
    });
  // A new client emulates cold start/deploy and sees migration marker missing.
  // Clear marker and initialize a separate connection to the same file.
  const c2 = createClient({ url: `file:${root}/${index - 1}.db` });
  await ensureSchema(c2);
  assert.equal(
    (await c2.execute("SELECT * FROM status_snapshot")).rows.length,
    2,
  );
  const r = await c2.execute(
    "SELECT * FROM current_items WHERE project_item_id='PVTI_TRANSFER'",
  );
  assert.equal(r.rows[0].canonical_url, moved);
  assert.equal(
    (
      await c2.execute(
        "SELECT * FROM issue_aliases WHERE project_item_id='PVTI_TRANSFER'",
      )
    ).rows.length,
    2,
  );
  c.close();
  c2.close();
});
test("F19 stale snapshot ditolak dan item project berbeda tidak bertabrakan", async () => {
  const c = db();
  await recordStatuses(c, [item("Ready to Review", "2026-10-15T04:00:00Z")]);
  const stale = await recordStatuses(c, [
    item("In Progress", "2026-10-15T03:00:00Z"),
  ]);
  assert.equal(stale.stale, 1);
  assert.equal((await getHistory(c, [url])).length, 1);
  await recordStatuses(c, [
    item("Todo", "2026-10-15T04:00:00Z", {
      projectItemId: "PVTI_OTHER",
      projectNumber: 99,
    }),
  ]);
  assert.equal((await c.execute("SELECT * FROM current_items")).rows.length, 2);
  c.close();
});
test("F19 newest active/sweep dipilih by timestamp dan poll lease eksklusif", async () => {
  const c = db();
  await ensureSchema(c);
  assert.equal(
    newestItems([
      item("Ready to Review", "2026-10-15T04:00:00Z"),
      item("In Progress", "2026-10-15T03:00:00Z"),
    ])[0].status,
    "Ready to Review",
  );
  assert.equal(await acquireLease(c, "a", "2026-10-15T03:00:00Z"), true);
  assert.equal(await acquireLease(c, "b", "2026-10-15T03:00:10Z"), false);
  await releaseLease(c, "b");
  assert.equal(await acquireLease(c, "b", "2026-10-15T03:00:20Z"), false);
  assert.equal(await acquireLease(c, "b", "2026-10-15T03:01:00Z"), true);
  c.close();
});
test("F20 unchanged memperbarui last polled dan active >500 bergiliran adil", async () => {
  const c = db(),
    items = Array.from({ length: 501 }, (_, i) =>
      item("In Progress", "2026-09-01T00:00:00Z", {
        projectItemId: `PVTI_${i}`,
        issueUrl: url + i,
      }),
    );
  await recordStatuses(c, items, "2026-10-15T03:00:00Z");
  const first = await getActiveProjectItemIds(c, "2026-10-01T00:00:00Z", 500);
  await recordStatuses(
    c,
    items.filter((i) => first.includes(i.projectItemId)),
    "2026-10-15T03:01:00Z",
  );
  const second = await getActiveProjectItemIds(c, "2026-10-01T00:00:00Z", 500);
  assert.equal(new Set([...first, ...second]).size, 501);
  const r = await c.execute({
    sql: "SELECT last_polled_at,last_status_change_at FROM current_items WHERE project_item_id=?",
    args: [first[0]],
  });
  assert.equal(r.rows[0].last_polled_at, "2026-10-15T03:01:00.000Z");
  assert.equal(r.rows[0].last_status_change_at, "2026-09-01T00:00:00.000Z");
  c.close();
});
test("F21 range WIB dinormalisasi UTC dan upper bound eksklusif", async () => {
  const c = db();
  await recordStatuses(c, [item("In Progress", "2026-10-14T18:00:00Z")]);
  await recordStatuses(c, [item("Ready to Review", "2026-10-15T17:00:00Z")]);
  const h = await getHistory(
    c,
    [url],
    "2026-10-15T00:00:00+07:00",
    "2026-10-16T00:00:00+07:00",
  );
  assert.equal(h.length, 1);
  assert.equal(h[0].newStatus, "In Progress");
  const context = await getHistory(
    c,
    [url],
    "2026-10-15T09:00:00+07:00",
    undefined,
    true,
  );
  assert.equal(context.length, 2);
  c.close();
});
test("F22 reject invalid shape/range/oversize explicitly; health freshness", async () => {
  assert.throws(() => parseHistoryRequest({ issueUrls: url }));
  assert.throws(() =>
    parseHistoryRequest({ issueUrls: [url], from: "yesterday" }),
  );
  assert.throws(() =>
    parseHistoryRequest({
      issueUrls: [url],
      from: "2026-10-16T00:00:00Z",
      to: "2026-10-15T00:00:00Z",
    }),
  );
  assert.throws(() => parseHistoryRequest({ issueUrls: Array(251).fill(url) }));
  const c = db();
  await ensureSchema(c);
  assert.equal((await readiness(c)).fresh, false);
  await setRecorderState(c, "last_successful_poll", new Date().toISOString());
  assert.equal((await readiness(c)).fresh, true);
  c.close();
});

test("reader tidak mengeksekusi DDL; migration ditolak bila legacy timestamp invalid", async () => {
  const c = db();
  await ensureSchema(c);
  await c.execute("DELETE FROM recorder_state WHERE key='schema_version'");
  await c.execute({
    sql: "INSERT INTO status_snapshot VALUES(?,?,?,?,?,?,?,?)",
    args: [
      url,
      "PVTI_INVALID",
      "Test",
      "a/b",
      1,
      "Todo",
      "invalid",
      "2026-10-15T03:00:00Z",
    ],
  });
  const c2 = createClient({ url: `file:${root}/${index - 1}.db` });
  await assert.rejects(() => ensureSchema(c2), /MIGRATION_PREFLIGHT_FAILED/);
  assert.equal(
    (await c2.execute("SELECT count(*) AS n FROM status_snapshot")).rows[0].n,
    1,
  );
  c.close();
  c2.close();
});
