import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
const directory = mkdtempSync(tmpdir() + "/recorder-routes-");
process.env.TURSO_DATABASE_URL = `file:${directory}/routes.db`;
process.env.TURSO_AUTH_TOKEN = "synthetic";
process.env.GITHUB_TOKEN = "synthetic";
process.env.CRON_SECRET = "synthetic-cron";
process.env.RECORDER_API_SECRET = "synthetic-api";
const { GET: poll } = await import("../app/api/record-status/route");
const { POST: history } = await import("../app/api/status-history/route");
const { GET: health } = await import("../app/api/health/route");
const { database } = await import("../lib/database");
const nativeFetch = globalThis.fetch;
let time = "2026-10-15T02:00:00Z",
  url = "https://github.com/GO-Bimbel/api/issues/1";
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      data: {
        organization: {
          projectV2: {
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "PVTI_1",
                  project: { number: 11 },
                  content: {
                    id: "I_1",
                    url,
                    title: "Synthetic",
                    number: 1,
                    repository: { nameWithOwner: "GO-Bimbel/api" },
                  },
                  fieldValueByName: { name: "In Progress", updatedAt: time },
                },
              ],
            },
          },
        },
        nodes: [
          {
            id: "PVTI_1",
            project: { number: 11 },
            content: {
              id: "I_1",
              url,
              title: "Synthetic",
              number: 1,
              repository: { nameWithOwner: "GO-Bimbel/api" },
            },
            fieldValueByName: { name: "In Progress", updatedAt: time },
          },
        ],
      },
    }),
    { status: 200 },
  );
after(() => {
  globalThis.fetch = nativeFetch;
  database().close();
  rmSync(directory, { recursive: true, force: true });
});
const cron = () =>
  new Request("https://recorder.test/api/record-status", {
    headers: { Authorization: "Bearer synthetic-cron" },
  });
const request = (body: unknown) =>
  new Request("https://recorder.test/api/status-history", {
    method: "POST",
    headers: {
      Authorization: "Bearer synthetic-api",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
test("API integration: auth → migration → poll → alias history → freshness/validation", async () => {
  assert.equal(
    (await poll(new Request("https://recorder.test/api/record-status"))).status,
    401,
  );
  assert.equal(
    (await health(new Request("https://recorder.test/api/health?check=live")))
      .status,
    200,
  );
  assert.equal(
    (await health(new Request("https://recorder.test/api/health"))).status,
    503,
  );
  const first = await poll(cron());
  assert.equal(first.status, 200);
  assert.equal((await first.json()).seeded, 1);
  time = "2026-10-15T02:00:40Z";
  const observed = await poll(cron());
  assert.equal((await observed.json()).observations, 1);
  const result = await history(
    request({
      issueUrls: [url],
      from: "2026-10-15T00:00:00+07:00",
      to: "2026-10-16T00:00:00+07:00",
      includeContext: true,
    }),
  );
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.equal(data.history.length, 1);
  assert.equal(data.observations.length, 1);
  assert.equal(data.coverage.processed, 1);
  assert.equal(data.coverage.truncated, false);
  assert.equal(data.coverage.transientBackfill, false);
  const old = url;
  url = "https://github.com/GO-Bimbel/moved/issues/2";
  await poll(cron());
  const alias = await (await history(request({ issueUrls: [old] }))).json();
  assert.equal(alias.history[0].issueUrl, url);
  assert.deepEqual(alias.history[0].requestedUrls, [old]);
  assert.equal(
    (await health(new Request("https://recorder.test/api/health"))).status,
    200,
  );
  assert.equal((await history(request({ issueUrls: "bad" }))).status, 400);
  assert.equal(
    (await history(request({ issueUrls: Array(251).fill(url) }))).status,
    400,
  );
  assert.equal(
    (
      await history(
        new Request("https://recorder.test/api/status-history", {
          method: "POST",
          body: "{}",
        }),
      )
    ).status,
    401,
  );
});
