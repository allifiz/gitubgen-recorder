import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchProjectStatusBatch,
  fetchProjectStatuses,
  fetchProjectStatusesByIds,
} from "../lib/github";

test("mengambil status Project V2 dan timestamp field Status", async () => {
  const fakeFetch: typeof fetch = async () =>
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
                    content: {
                      number: 3908,
                      title: "Get Option Produk",
                      url: "https://github.com/GO-Bimbel/api/issues/3908",
                      repository: { nameWithOwner: "GO-Bimbel/api" },
                    },
                    fieldValueByName: {
                      name: "In Progress",
                      updatedAt: "2026-10-14T02:15:00Z",
                    },
                  },
                ],
              },
            },
          },
        },
      }),
      { status: 200 },
    );
  const rows = await fetchProjectStatuses({
    token: "test",
    org: "GO-Bimbel",
    projectNumber: 11,
    fetchImpl: fakeFetch,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "In Progress");
  assert.equal(rows[0].statusUpdatedAt, "2026-10-14T02:15:00Z");
});

test("mengikuti pagination Project V2", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        data: {
          organization: {
            projectV2: {
              items: {
                pageInfo: {
                  hasNextPage: calls === 1,
                  endCursor: calls === 1 ? "cursor-1" : null,
                },
                nodes: [],
              },
            },
          },
        },
      }),
      { status: 200 },
    );
  };
  await fetchProjectStatuses({
    token: "test",
    org: "GO-Bimbel",
    projectNumber: 11,
    fetchImpl: fakeFetch,
  });
  assert.equal(calls, 2);
});

test("batch berhenti sesuai batas halaman dan mengembalikan cursor", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        data: {
          organization: {
            projectV2: {
              items: {
                pageInfo: { hasNextPage: true, endCursor: `cursor-${calls}` },
                nodes: [],
              },
            },
          },
        },
      }),
      { status: 200 },
    );
  };
  const batch = await fetchProjectStatusBatch({
    token: "test",
    org: "GO-Bimbel",
    projectNumber: 11,
    maxPages: 5,
    fetchImpl: fakeFetch,
  });
  assert.equal(calls, 5);
  assert.equal(batch.nextCursor, "cursor-5");
  assert.equal(batch.completedSweep, false);
});

test("fast poll mengambil project item berdasarkan ID dalam batch 100", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        data: {
          nodes: body.variables.ids.map((id: string) => ({
            id,
            content: {
              number: 3908,
              title: "Get Option Produk",
              url: `https://github.com/GO-Bimbel/api/issues/${id}`,
              repository: { nameWithOwner: "GO-Bimbel/api" },
            },
            fieldValueByName: {
              name: "In Progress",
              updatedAt: "2026-10-14T02:15:00Z",
            },
          })),
        },
      }),
      { status: 200 },
    );
  };
  const rows = await fetchProjectStatusesByIds({
    token: "test",
    projectItemIds: Array.from({ length: 125 }, (_, index) => `PVTI_${index}`),
    fetchImpl: fakeFetch,
  });
  assert.equal(calls, 2);
  assert.equal(rows.length, 125);
});

test("status field dikosongkan tetap menghasilkan No status dengan kualitas waktu observasi", async () => {
  const result = await fetchProjectStatusesByIds({
    token: "test",
    projectItemIds: ["PVTI_CLEAR"],
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          data: {
            nodes: [
              {
                id: "PVTI_CLEAR",
                updatedAt: "2026-10-15T03:00:00Z",
                project: { number: 11 },
                content: {
                  id: "I_1",
                  url: "https://github.com/a/b/issues/1",
                  number: 1,
                },
                fieldValueByName: null,
              },
            ],
          },
        }),
        { status: 200 },
      ),
  });
  assert.equal(result[0].status, "No status");
  assert.equal(result[0].statusTimeSource, "item_updated_at");
  assert.equal(result[0].issueNodeId, "I_1");
});
