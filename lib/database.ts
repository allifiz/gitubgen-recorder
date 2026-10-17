import { createClient, type Client } from "@libsql/client";
import { tursoConfig } from "./env";
import type { ProjectItemStatus } from "./types";
let sharedClient: Client | null = null;
export function database() {
  return (sharedClient ||= createClient(tursoConfig()));
}
const initialized = new WeakMap<Client, Promise<void>>();
export async function ensureSchema(client: Client) {
  let promise = initialized.get(client);
  if (!promise) {
    promise = migrate(client).catch((e) => {
      initialized.delete(client);
      throw e;
    });
    initialized.set(client, promise);
  }
  await promise;
}
async function migrate(client: Client) {
  try {
    const r = await client.execute(
      "SELECT value FROM recorder_state WHERE key='schema_version'",
    );
    if (r.rows[0]?.value === "2") return;
  } catch {}
  await client.batch(
    [
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
      "CREATE INDEX IF NOT EXISTS idx_snapshot_status_updated ON status_snapshot(status_updated_at)",
      "CREATE INDEX IF NOT EXISTS idx_snapshot_current_status_updated ON status_snapshot(current_status, status_updated_at)",
      "CREATE INDEX IF NOT EXISTS idx_history_issue_occurred ON status_history(issue_url, occurred_at)",
      "CREATE INDEX IF NOT EXISTS idx_history_occurred ON status_history(occurred_at)",
    ],
    "write",
  );
  const invalid = await client.execute(`SELECT
    (SELECT count(*) FROM status_snapshot WHERE julianday(status_updated_at) IS NULL OR julianday(checked_at) IS NULL)+
    (SELECT count(*) FROM status_history WHERE julianday(occurred_at) IS NULL OR julianday(detected_at) IS NULL) AS bad`);
  if (Number(invalid.rows[0].bad))
    throw new Error(
      "MIGRATION_PREFLIGHT_FAILED: invalid legacy timestamps; legacy data unchanged.",
    );
  // Additive migration. Legacy tables are the immutable pre-migration backup.
  // Identity mapping is exclusively project_item_id, never title/number similarity.
  await client.batch(
    [
      `CREATE TABLE IF NOT EXISTS current_items (
    project_item_id TEXT PRIMARY KEY, project_number INTEGER NOT NULL DEFAULT 11,
    issue_node_id TEXT, canonical_url TEXT NOT NULL,title TEXT NOT NULL,repository TEXT NOT NULL,issue_number INTEGER NOT NULL,
    current_status TEXT NOT NULL,status_updated_at TEXT NOT NULL,last_polled_at TEXT NOT NULL,last_status_change_at TEXT NOT NULL,last_attempted_at TEXT)`,
      `CREATE TABLE IF NOT EXISTS issue_aliases (issue_url TEXT NOT NULL,project_item_id TEXT NOT NULL,PRIMARY KEY(issue_url,project_item_id))`,
      `CREATE TABLE IF NOT EXISTS status_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,legacy_id INTEGER UNIQUE,project_item_id TEXT NOT NULL,issue_url TEXT NOT NULL,
    previous_status TEXT,new_status TEXT NOT NULL,occurred_at TEXT NOT NULL,detected_at TEXT NOT NULL,
    source TEXT NOT NULL,kind TEXT NOT NULL,gap INTEGER NOT NULL DEFAULT 0,
    UNIQUE(project_item_id,new_status,occurred_at,kind))`,
      `CREATE TABLE IF NOT EXISTS poll_leases (name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_current_active ON current_items(last_polled_at,status_updated_at,current_status)`,
      `CREATE INDEX IF NOT EXISTS idx_event_item_time ON status_events(project_item_id,occurred_at)`,
      `INSERT OR IGNORE INTO current_items(project_item_id,project_number,issue_node_id,canonical_url,title,repository,issue_number,current_status,status_updated_at,last_polled_at,last_status_change_at)
    SELECT project_item_id,11,NULL,issue_url,title,repository,issue_number,current_status,
      strftime('%Y-%m-%dT%H:%M:%fZ',status_updated_at),strftime('%Y-%m-%dT%H:%M:%fZ',checked_at),strftime('%Y-%m-%dT%H:%M:%fZ',status_updated_at)
    FROM (SELECT *,row_number() OVER(PARTITION BY project_item_id ORDER BY julianday(status_updated_at) DESC,julianday(checked_at) DESC,issue_url) AS rn FROM status_snapshot) WHERE rn=1`,
      `INSERT OR IGNORE INTO issue_aliases SELECT issue_url,project_item_id FROM status_snapshot`,
      `INSERT OR IGNORE INTO issue_aliases SELECT issue_url,project_item_id FROM status_history`,
      `INSERT OR IGNORE INTO status_events(legacy_id,project_item_id,issue_url,previous_status,new_status,occurred_at,detected_at,source,kind,gap)
    SELECT id,project_item_id,issue_url,previous_status,new_status,strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at),strftime('%Y-%m-%dT%H:%M:%fZ',detected_at),source,
    CASE WHEN previous_status=new_status THEN 'observation' WHEN source='baseline' THEN 'baseline' ELSE 'transition' END,
    CASE WHEN previous_status=new_status THEN 1 ELSE 0 END FROM status_history`,
      `INSERT INTO recorder_state(key,value,updated_at) VALUES('schema_version','2',strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO UPDATE SET value='2'`,
    ],
    "write",
  );
}
export function utc(value: string) {
  if (
    typeof value !== "string" ||
    !/(?:Z|[+-]\d\d:\d\d)$/i.test(value) ||
    !Number.isFinite(+new Date(value))
  )
    throw new Error("Timestamp wajib ISO dengan timezone.");
  return new Date(value).toISOString();
}
export async function getRecorderState(client: Client, key: string) {
  const r = await client.execute({
    sql: "SELECT value FROM recorder_state WHERE key=?",
    args: [key],
  });
  return r.rows[0]?.value == null ? null : String(r.rows[0].value);
}
export async function setRecorderState(
  client: Client,
  key: string,
  value: string | null,
  now = new Date().toISOString(),
) {
  await ensureSchema(client);
  if (value == null) {
    await client.execute({
      sql: "DELETE FROM recorder_state WHERE key=?",
      args: [key],
    });
    return;
  }
  await client.execute({
    sql: `INSERT INTO recorder_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
    args: [key, value, utc(now)],
  });
}
export async function getActiveProjectItemIds(
  client: Client,
  recentSince: string,
  limit = 500,
) {
  const r = await client.execute({
    sql: `SELECT project_item_id FROM current_items WHERE status_updated_at>=? OR lower(current_status)='in progress' ORDER BY coalesce(last_attempted_at,last_polled_at) ASC,project_item_id LIMIT ?`,
    args: [utc(recentSince), limit],
  });
  return r.rows.map((r) => String(r.project_item_id));
}
export function newestItems(items: ProjectItemStatus[]) {
  const map = new Map<string, ProjectItemStatus>();
  for (const item of items) {
    const old = map.get(item.projectItemId);
    if (
      !old ||
      +new Date(item.statusUpdatedAt) > +new Date(old.statusUpdatedAt) ||
      (+new Date(item.statusUpdatedAt) === +new Date(old.statusUpdatedAt) &&
        item.observedAt &&
        (!old.observedAt || item.observedAt > old.observedAt))
    )
      map.set(item.projectItemId, item);
  }
  return [...map.values()];
}
export async function recordStatuses(
  client: Client,
  items: ProjectItemStatus[],
  now = new Date().toISOString(),
) {
  await ensureSchema(client);
  now = utc(now);
  let seeded = 0,
    changed = 0,
    unchanged = 0,
    observations = 0,
    stale = 0;
  const tx = await client.transaction("write");
  try {
    // One read and batched writes avoid per-item network roundtrips.
    const current = new Map<string, Record<string, any>>();
    const ids = [...new Set(items.map((i) => i.projectItemId))];
    for (let i = 0; i < ids.length; i += 350) {
      const chunk = ids.slice(i, i + 350);
      const existing = await tx.execute({
        sql: `SELECT project_item_id,current_status,status_updated_at,last_status_change_at FROM current_items WHERE project_item_id IN (${chunk.map(() => "?").join(",")})`,
        args: chunk,
      });
      for (const row of existing.rows)
        current.set(String(row.project_item_id), row);
    }
    const writes: Array<{ sql: string; args: Array<string | number | null> }> =
      [];
    for (const item of newestItems(items)) {
      const occurred = utc(item.statusUpdatedAt),
        old = current.get(item.projectItemId);
      writes.push({
        sql: "INSERT OR IGNORE INTO issue_aliases(issue_url,project_item_id) VALUES(?,?)",
        args: [item.issueUrl, item.projectItemId],
      });
      if (old && occurred < String(old.status_updated_at)) {
        stale++;
        continue;
      }
      if (
        old &&
        occurred === String(old.status_updated_at) &&
        item.status !== old.current_status
      ) {
        stale++;
        continue;
      }
      const isChanged = !!old && old.current_status !== item.status,
        timestampChanged = !!old && occurred !== old.status_updated_at;
      if (!old || isChanged || timestampChanged) {
        const kind = !old
          ? "baseline"
          : isChanged
            ? "transition"
            : "observation";
        writes.push({
          sql: `INSERT OR IGNORE INTO status_events(project_item_id,issue_url,previous_status,new_status,occurred_at,detected_at,source,kind,gap) VALUES(?,?,?,?,?,?,?,?,?)`,
          args: [
            item.projectItemId,
            item.issueUrl,
            old ? String(old.current_status) : null,
            item.status,
            occurred,
            now,
            !old ? "baseline" : "poll",
            kind,
            (timestampChanged && !isChanged) ||
            item.statusTimeSource === "item_updated_at"
              ? 1
              : 0,
          ],
        });
        if (!old) seeded++;
        else if (isChanged) changed++;
        else observations++;
      } else unchanged++;
      writes.push({
        sql: `INSERT INTO current_items(project_item_id,project_number,issue_node_id,canonical_url,title,repository,issue_number,current_status,status_updated_at,last_polled_at,last_status_change_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_item_id) DO UPDATE SET
    project_number=excluded.project_number,issue_node_id=coalesce(excluded.issue_node_id,current_items.issue_node_id),canonical_url=excluded.canonical_url,title=excluded.title,repository=excluded.repository,issue_number=excluded.issue_number,current_status=excluded.current_status,status_updated_at=excluded.status_updated_at,last_polled_at=excluded.last_polled_at,last_status_change_at=excluded.last_status_change_at
    WHERE excluded.status_updated_at>=current_items.status_updated_at`,
        args: [
          item.projectItemId,
          item.projectNumber || 11,
          item.issueNodeId || null,
          item.issueUrl,
          item.title,
          item.repository,
          item.number,
          item.status,
          occurred,
          now,
          !old || isChanged ? occurred : String(old.last_status_change_at),
        ],
      });
    }
    for (let i = 0; i < writes.length; i += 100)
      await tx.batch(writes.slice(i, i + 100));
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  } finally {
    tx.close();
  }
  return {
    scanned: items.length,
    seeded,
    changed,
    unchanged,
    observations,
    stale,
    recordedAt: now,
  };
}
export async function getHistory(
  client: Client,
  issueUrls: string[],
  from?: string,
  to?: string,
  includeContext = false,
  includeObservations = false,
) {
  if (!issueUrls.length) return [];
  const args: Array<string> = [...issueUrls],
    where = [
      `a.issue_url IN (${issueUrls.map(() => "?").join(",")})`,
      includeObservations ? "1=1" : `h.kind!='observation'`,
    ];
  if (from) {
    where.push(
      "(h.occurred_at>=?" +
        (includeContext
          ? ` OR h.id=(SELECT p.id FROM status_events p WHERE p.project_item_id=h.project_item_id AND p.kind!='observation' AND p.occurred_at<? ORDER BY p.occurred_at DESC,p.id DESC LIMIT 1)`
          : "") +
        ")",
    );
    args.push(utc(from));
    if (includeContext) args.push(utc(from));
  }
  if (to) {
    where.push("h.occurred_at<?");
    args.push(utc(to));
  }
  const r = await client.execute({
    sql: `SELECT h.*,a.issue_url AS requested_url,c.canonical_url,c.project_number,c.issue_node_id,c.title,c.repository,c.issue_number FROM issue_aliases a JOIN status_events h USING(project_item_id) JOIN current_items c USING(project_item_id) WHERE ${where.join(" AND ")} ORDER BY h.occurred_at,h.id`,
    args,
  });
  const events = new Map<number, any>();
  for (const row of r.rows) {
    const id = Number(row.id),
      e = events.get(id) || {
        id,
        issueUrl: String(row.canonical_url),
        originalIssueUrl: String(row.issue_url),
        projectItemId: String(row.project_item_id),
        projectNumber: Number(row.project_number),
        issueNodeId: row.issue_node_id,
        title: String(row.title),
        repository: String(row.repository),
        number: Number(row.issue_number),
        previousStatus:
          row.previous_status == null ? null : String(row.previous_status),
        newStatus: String(row.new_status),
        occurredAt: String(row.occurred_at),
        detectedAt: String(row.detected_at),
        source: String(row.source),
        gap: !!row.gap,
        observationOnly: row.kind === "observation",
        requestedUrls: [],
      };
    e.requestedUrls.push(String(row.requested_url));
    events.set(id, e);
  }
  return [...events.values()];
}
export async function acquireLease(
  client: Client,
  owner: string,
  now = new Date().toISOString(),
  ttlMs = 45000,
) {
  const expires = new Date(+new Date(now) + ttlMs).toISOString();
  const r = await client.execute({
    sql: `INSERT INTO poll_leases(name,owner,expires_at) VALUES('poll',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE poll_leases.expires_at<=? RETURNING owner`,
    args: [owner, expires, utc(now)],
  });
  return r.rows.length > 0;
}
export async function releaseLease(client: Client, owner: string) {
  await client.execute({
    sql: "DELETE FROM poll_leases WHERE name='poll' AND owner=?",
    args: [owner],
  });
}
export async function readiness(client: Client) {
  const rows = await client.execute(
    "SELECT key,value FROM recorder_state WHERE key IN ('last_successful_poll','last_completed_sweep','last_poll_error','schema_version')",
  );
  const state = Object.fromEntries(
    rows.rows.map((r) => [String(r.key), String(r.value)]),
  );
  const last = state.last_successful_poll;
  return {
    ready: state.schema_version === "2",
    fresh: !!last && Date.now() - +new Date(last) < 180000,
    lastSuccessfulPoll: last || null,
    lastCompletedSweep: state.last_completed_sweep || null,
    lastError: state.last_poll_error || null,
    schemaVersion: state.schema_version || null,
  };
}

export async function markActiveAttempt(
  client: Client,
  ids: string[],
  now = new Date().toISOString(),
) {
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    await client.execute({
      sql: `UPDATE current_items SET last_attempted_at=? WHERE project_item_id IN (${chunk.map(() => "?").join(",")})`,
      args: [utc(now), ...chunk],
    });
  }
}
