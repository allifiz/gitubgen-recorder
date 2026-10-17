export type ProjectItemStatus = {
  projectItemId: string;
  issueNodeId?: string;
  projectNumber?: number;
  observedAt?: string;
  statusTimeSource?: string;
  issueUrl: string;
  title: string;
  repository: string;
  number: number;
  status: string;
  statusUpdatedAt: string;
};

export type StatusTransition = {
  issueUrl: string;
  projectItemId: string;
  issueNodeId?: string;
  projectNumber?: number;
  observedAt?: string;
  statusTimeSource?: string;
  title: string;
  repository: string;
  number: number;
  previousStatus: string | null;
  newStatus: string;
  occurredAt: string;
  detectedAt: string;
  source: "baseline" | "poll";
};
