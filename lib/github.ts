import type { ProjectItemStatus } from "./types";

const ENDPOINT = "https://api.github.com/graphql";
const QUERY = `
query ProjectStatuses($org: String!, $number: Int!, $after: String) {
  organization(login: $org) {
    projectV2(number: $number) {
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id updatedAt
          project { number }
          content {
            ... on Issue { id number title url repository { nameWithOwner } }
            ... on PullRequest { id number title url repository { nameWithOwner } }
          }
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt }
          }
        }
      }
    }
  }
}`;

const NODES_QUERY = `
query ProjectStatusNodes($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on ProjectV2Item {
      id updatedAt
      project { number }
      content {
        ... on Issue { id number title url repository { nameWithOwner } }
        ... on PullRequest { id number title url repository { nameWithOwner } }
      }
      fieldValueByName(name: "Status") {
        ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt }
      }
    }
  }
}`;

type FetchLike = typeof fetch;

type ProjectStatusBatch = {
  items: ProjectItemStatus[];
  nextCursor: string | null;
  completedSweep: boolean;
  pages: number;
};

function parseProjectItem(node: any): ProjectItemStatus | null {
  const content = node?.content;
  const status = node?.fieldValueByName;
  if (!node?.id || !content?.url) return null;
  if (!status?.updatedAt && !node.updatedAt) return null;
  return {
    projectItemId: node.id,
    issueNodeId: content.id,
    projectNumber: node.project?.number || 11,
    observedAt: new Date().toISOString(),
    issueUrl: content.url,
    title: content.title || "",
    repository: content.repository?.nameWithOwner || "",
    number: Number(content.number || 0),
    status: status?.name || "No status",
    statusTimeSource: status?.updatedAt ? "status_field" : "item_updated_at",
    statusUpdatedAt: status?.updatedAt || node.updatedAt,
  };
}

async function githubGraphql(
  fetchImpl: FetchLike,
  token: string,
  query: string,
  variables: object,
) {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 250));
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      signal: AbortSignal.timeout(8000),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "gitubgen-recorder/0.1",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (response.status < 500 || attempt) break;
  }
  if (!response) throw new Error("GitHub response missing");
  const payload = (await response.json()) as any;
  if (!response.ok)
    throw new Error(
      `GitHub GraphQL gagal (${response.status}); remaining=${response.headers.get("x-ratelimit-remaining") || "unknown"}.`,
    );
  if (payload.errors?.length)
    throw new Error(
      payload.errors.map((error: any) => error.message).join("; "),
    );
  return payload.data;
}

export async function fetchProjectStatusBatch(input: {
  token: string;
  org: string;
  projectNumber: number;
  after?: string | null;
  maxPages?: number;
  deadline?: number;
  fetchImpl?: FetchLike;
}): Promise<ProjectStatusBatch> {
  const fetchImpl = input.fetchImpl || fetch;
  const collected: ProjectItemStatus[] = [];
  const maxPages = Math.max(1, Math.min(input.maxPages || 5, 10));
  let after: string | null = input.after || null;
  let pages = 0;
  let hasNextPage = false;

  do {
    const data = await githubGraphql(fetchImpl, input.token, QUERY, {
      org: input.org,
      number: input.projectNumber,
      after,
    });
    const project = data?.organization?.projectV2;
    if (!project)
      throw new Error(
        "Project GitHub tidak ditemukan atau token tidak memiliki akses.",
      );
    const connection = project.items;
    for (const node of connection.nodes || []) {
      const item = parseProjectItem(node);
      if (item) collected.push(item);
    }
    pages += 1;
    hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
    after = hasNextPage ? connection.pageInfo.endCursor : null;
  } while (
    hasNextPage &&
    pages < maxPages &&
    (!input.deadline || Date.now() < input.deadline - 3000)
  );

  return {
    items: collected,
    nextCursor: after,
    completedSweep: !hasNextPage,
    pages,
  };
}

export async function fetchProjectStatusesByIds(input: {
  token: string;
  projectItemIds: string[];
  fetchImpl?: FetchLike;
}): Promise<ProjectItemStatus[]> {
  const fetchImpl = input.fetchImpl || fetch;
  const uniqueIds = [...new Set(input.projectItemIds.filter(Boolean))];
  const chunks: string[][] = [];
  for (let index = 0; index < uniqueIds.length; index += 100) {
    chunks.push(uniqueIds.slice(index, index + 100));
  }
  const results = await Promise.all(
    chunks.map(async (ids) => {
      const data = await githubGraphql(fetchImpl, input.token, NODES_QUERY, {
        ids,
      });
      return (data?.nodes || [])
        .map(parseProjectItem)
        .filter(Boolean) as ProjectItemStatus[];
    }),
  );
  return results.flat();
}

export async function fetchProjectStatuses(input: {
  token: string;
  org: string;
  projectNumber: number;
  fetchImpl?: FetchLike;
}): Promise<ProjectItemStatus[]> {
  const collected: ProjectItemStatus[] = [];
  let after: string | null = null;

  do {
    const batch = await fetchProjectStatusBatch({
      ...input,
      after,
      maxPages: 10,
    });
    collected.push(...batch.items);
    after = batch.nextCursor;
  } while (after);

  return collected;
}
