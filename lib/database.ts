import { createClient, type Client } from '@libsql/client';
import { tursoConfig } from './env';
import type { ProjectItemStatus, StatusTransition } from './types';

let sharedClient: Client | null = null;

export function database() {
  if (!sharedClient) sharedClient = createClient(tursoConfig());
  return sharedClient;
}

export async function ensureSchema(client: Client) {
  await client.batch([
    `CREATE TABLE IF NOT EXISTS status_snapshot (
      issue_url TEXT PRIMARY KEY,
      project_item_id TEXT NOT NULL,
      title TEXT NOT NULL,
      repository TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      current_status TEXT NOT NULL,
      status_updated_at TEXT NOT NULL,
      checked_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_url TEXT NOT NULL,
      project_item_id TEXT NOT NULL,
      title TEXT NOT NULL,
      repository TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      previous_status TEXT,
      new_status TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('baseline', 'poll')),
      UNIQUE(issue_url, new_status, occurred_at)
    )`,
    `CREATE TABLE IF NOT EXISTS recorder_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_history_issue_occurred ON status_history(issue_url, occurred_at)',
    'CREATE INDEX IF NOT EXISTS idx_history_occurred ON status_history(occurred_at)'
  ], 'write');
}

export async function getRecorderState(client: Client, key: string) {
  await ensureSchema(client);
  const result = await client.execute({ sql: 'SELECT value FROM recorder_state WHERE key = ?', args: [key] });
  return result.rows[0]?.value == null ? null : String(result.rows[0].value);
}

export async function setRecorderState(client: Client, key: string, value: string | null, now = new Date().toISOString()) {
  await ensureSchema(client);
  if (value == null) {
    await client.execute({ sql: 'DELETE FROM recorder_state WHERE key = ?', args: [key] });
    return;
  }
  await client.execute({
    sql: `INSERT INTO recorder_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    args: [key, value, now]
  });
}

export async function getActiveProjectItemIds(
  client: Client,
  recentSince: string,
  limit = 500
) {
  await ensureSchema(client);
  const result = await client.execute({
    sql: `SELECT project_item_id
      FROM status_snapshot
      WHERE status_updated_at >= ? OR current_status = 'In Progress'
      ORDER BY status_updated_at DESC
      LIMIT ?`,
    args: [recentSince, limit]
  });
  return result.rows.map(row => String(row.project_item_id));
}

export async function recordStatuses(client: Client, items: ProjectItemStatus[], now = new Date().toISOString()) {
  await ensureSchema(client);
  let seeded = 0;
  let changed = 0;
  let unchanged = 0;

  const snapshots = await client.execute(
    'SELECT issue_url, current_status, status_updated_at FROM status_snapshot'
  );
  const existingByUrl = new Map(snapshots.rows.map(row => [String(row.issue_url), {
    currentStatus: String(row.current_status),
    statusUpdatedAt: String(row.status_updated_at)
  }]));
  const writes: Array<{ sql: string; args: Array<string | number | null> }> = [];

  for (const item of items) {
    const snapshot = existingByUrl.get(item.issueUrl);
    const previousStatus = snapshot?.currentStatus ?? null;
    const isNew = !snapshot;
    const isChanged = Boolean(snapshot && (previousStatus !== item.status || snapshot.statusUpdatedAt !== item.statusUpdatedAt));

    if (isNew || isChanged) {
      const transition: StatusTransition = {
        issueUrl: item.issueUrl,
        projectItemId: item.projectItemId,
        title: item.title,
        repository: item.repository,
        number: item.number,
        previousStatus,
        newStatus: item.status,
        occurredAt: item.statusUpdatedAt,
        detectedAt: now,
        source: isNew ? 'baseline' : 'poll'
      };
      writes.push({
        sql: `INSERT OR IGNORE INTO status_history
          (issue_url, project_item_id, title, repository, issue_number, previous_status, new_status, occurred_at, detected_at, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [transition.issueUrl, transition.projectItemId, transition.title, transition.repository,
          transition.number, transition.previousStatus, transition.newStatus, transition.occurredAt,
          transition.detectedAt, transition.source]
      }, {
        sql: `INSERT INTO status_snapshot
          (issue_url, project_item_id, title, repository, issue_number, current_status, status_updated_at, checked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(issue_url) DO UPDATE SET
            project_item_id=excluded.project_item_id, title=excluded.title, repository=excluded.repository,
            issue_number=excluded.issue_number, current_status=excluded.current_status,
            status_updated_at=excluded.status_updated_at, checked_at=excluded.checked_at`,
        args: [item.issueUrl, item.projectItemId, item.title, item.repository, item.number,
          item.status, item.statusUpdatedAt, now]
      });
      if (isNew) seeded += 1; else changed += 1;
    } else {
      unchanged += 1;
    }
  }

  for (let index = 0; index < writes.length; index += 100) {
    await client.batch(writes.slice(index, index + 100), 'write');
  }
  return { scanned: items.length, seeded, changed, unchanged, recordedAt: now };
}

export async function getHistory(client: Client, issueUrls: string[], from?: string, to?: string) {
  await ensureSchema(client);
  if (!issueUrls.length) return [];
  const placeholders = issueUrls.map(() => '?').join(',');
  const clauses = [`issue_url IN (${placeholders})`];
  const args: Array<string> = [...issueUrls];
  if (from) { clauses.push('occurred_at >= ?'); args.push(from); }
  if (to) { clauses.push('occurred_at <= ?'); args.push(to); }
  const result = await client.execute({
    sql: `SELECT issue_url, project_item_id, title, repository, issue_number,
      previous_status, new_status, occurred_at, detected_at, source
      FROM status_history WHERE ${clauses.join(' AND ')} ORDER BY occurred_at ASC`,
    args
  });
  return result.rows.map(row => ({
    issueUrl: String(row.issue_url), projectItemId: String(row.project_item_id), title: String(row.title),
    repository: String(row.repository), number: Number(row.issue_number),
    previousStatus: row.previous_status == null ? null : String(row.previous_status),
    newStatus: String(row.new_status), occurredAt: String(row.occurred_at),
    detectedAt: String(row.detected_at), source: String(row.source)
  }));
}
