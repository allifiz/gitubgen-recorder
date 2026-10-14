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
    'CREATE INDEX IF NOT EXISTS idx_history_issue_occurred ON status_history(issue_url, occurred_at)',
    'CREATE INDEX IF NOT EXISTS idx_history_occurred ON status_history(occurred_at)'
  ], 'write');
}

export async function recordStatuses(client: Client, items: ProjectItemStatus[], now = new Date().toISOString()) {
  await ensureSchema(client);
  let seeded = 0;
  let changed = 0;
  let unchanged = 0;

  for (const item of items) {
    const existing = await client.execute({
      sql: 'SELECT current_status, status_updated_at FROM status_snapshot WHERE issue_url = ?',
      args: [item.issueUrl]
    });
    const row = existing.rows[0];
    const previousStatus = row ? String(row.current_status) : null;
    const isNew = !row;
    const isChanged = Boolean(row && (previousStatus !== item.status || String(row.status_updated_at) !== item.statusUpdatedAt));

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
      await client.batch([
        {
          sql: `INSERT OR IGNORE INTO status_history
            (issue_url, project_item_id, title, repository, issue_number, previous_status, new_status, occurred_at, detected_at, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [transition.issueUrl, transition.projectItemId, transition.title, transition.repository,
            transition.number, transition.previousStatus, transition.newStatus, transition.occurredAt,
            transition.detectedAt, transition.source]
        },
        {
          sql: `INSERT INTO status_snapshot
            (issue_url, project_item_id, title, repository, issue_number, current_status, status_updated_at, checked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(issue_url) DO UPDATE SET
              project_item_id=excluded.project_item_id, title=excluded.title, repository=excluded.repository,
              issue_number=excluded.issue_number, current_status=excluded.current_status,
              status_updated_at=excluded.status_updated_at, checked_at=excluded.checked_at`,
          args: [item.issueUrl, item.projectItemId, item.title, item.repository, item.number,
            item.status, item.statusUpdatedAt, now]
        }
      ], 'write');
      if (isNew) seeded += 1; else changed += 1;
    } else {
      await client.execute({ sql: 'UPDATE status_snapshot SET checked_at = ? WHERE issue_url = ?', args: [now, item.issueUrl] });
      unchanged += 1;
    }
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
