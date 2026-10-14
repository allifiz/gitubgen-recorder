import type { ProjectItemStatus } from './types';

const ENDPOINT = 'https://api.github.com/graphql';
const QUERY = `
query ProjectStatuses($org: String!, $number: Int!, $after: String) {
  organization(login: $org) {
    projectV2(number: $number) {
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content {
            ... on Issue { number title url repository { nameWithOwner } }
            ... on PullRequest { number title url repository { nameWithOwner } }
          }
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt }
          }
        }
      }
    }
  }
}`;

type FetchLike = typeof fetch;

export async function fetchProjectStatuses(input: {
  token: string;
  org: string;
  projectNumber: number;
  fetchImpl?: FetchLike;
}): Promise<ProjectItemStatus[]> {
  const fetchImpl = input.fetchImpl || fetch;
  const collected: ProjectItemStatus[] = [];
  let after: string | null = null;

  do {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
        'user-agent': 'gitubgen-recorder/0.1'
      },
      body: JSON.stringify({
        query: QUERY,
        variables: { org: input.org, number: input.projectNumber, after }
      })
    });
    const payload = await response.json() as any;
    if (!response.ok) throw new Error(`GitHub GraphQL gagal (${response.status}).`);
    if (payload.errors?.length) throw new Error(payload.errors.map((e: any) => e.message).join('; '));

    const project = payload.data?.organization?.projectV2;
    if (!project) throw new Error('Project GitHub tidak ditemukan atau token tidak memiliki akses.');
    const connection = project.items;
    for (const node of connection.nodes || []) {
      const content = node?.content;
      const status = node?.fieldValueByName;
      if (!content?.url || !status?.name || !status?.updatedAt) continue;
      collected.push({
        projectItemId: node.id,
        issueUrl: content.url,
        title: content.title || '',
        repository: content.repository?.nameWithOwner || '',
        number: Number(content.number || 0),
        status: status.name,
        statusUpdatedAt: status.updatedAt
      });
    }
    after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);

  return collected;
}
