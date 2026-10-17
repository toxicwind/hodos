/**
 * astmatrix-ts — provider health tracking in SQLite (WAL mode).
 * Port of herd/internal/astmatrix/healthdb.go (Go) to Bun/TypeScript.
 * Uses bun:sqlite (built into Bun — no external dependency).
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ProviderHealth {
  successes: number;
  failures: number;
  successRate: number;
  avgLatency: number;
  rateLimited: number;
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status INTEGER NOT NULL,
    latency_ms REAL NOT NULL,
    strategy TEXT NOT NULL DEFAULT '',
    winner INTEGER NOT NULL DEFAULT 0,
    session_id TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_req_prov_model ON requests(provider, model)`,
  `CREATE INDEX IF NOT EXISTS idx_req_ts ON requests(ts)`,
  `CREATE TABLE IF NOT EXISTS model_health (
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    window_start REAL NOT NULL,
    successes INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    rate_limited INTEGER NOT NULL DEFAULT 0,
    total_ms REAL NOT NULL DEFAULT 0,
    min_ms REAL NOT NULL DEFAULT 999999,
    max_ms REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, model, window_start)
  )`,
  `CREATE TABLE IF NOT EXISTS healing_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    event TEXT NOT NULL,
    prev_status TEXT NOT NULL DEFAULT '',
    new_status TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    retry_after REAL DEFAULT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS session_affinity (
    session_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    updated_at REAL NOT NULL
  )`,
];

export class HealthDB {
  private db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    // WAL mode + NORMAL sync + busy timeout, mirroring the Go DSN:
    // file:<path>?_journal_mode=WAL&_synchronous=NORMAL&_busy_timeout=5000
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.db.exec("PRAGMA busy_timeout=5000;");
    for (const stmt of MIGRATIONS) this.db.exec(stmt);
  }

  close(): void {
    this.db.close();
  }

  /** Insert a request record and update the 5-minute windowed model_health. */
  recordRequest(
    provider: string,
    model: string,
    status: number,
    latencyMs: number,
    strategy: string,
    winner: number,
    sessionID: string,
  ): void {
    const now = Date.now() / 1000;
    const window = now - (Math.floor(now) % 300);
    this.db
      .query(
        `INSERT INTO requests (ts,provider,model,status,latency_ms,strategy,winner,session_id)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(now, provider, model, status, latencyMs, strategy, winner, sessionID);

    if (status === 200) {
      this.db
        .query(
          `INSERT INTO model_health (provider,model,window_start,successes,failures,total_ms,min_ms,max_ms)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(provider,model,window_start) DO UPDATE SET
             successes=successes+1,
             total_ms=total_ms+excluded.total_ms,
             min_ms=min(min_ms,excluded.min_ms),
             max_ms=max(max_ms,excluded.max_ms)`,
        )
        .run(provider, model, window, 1, 0, latencyMs, latencyMs, latencyMs);
    } else if (status === 429) {
      this.db
        .query(
          `INSERT INTO model_health (provider,model,window_start,successes,failures,rate_limited,total_ms,min_ms,max_ms)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(provider,model,window_start) DO UPDATE SET
             rate_limited=rate_limited+1`,
        )
        .run(provider, model, window, 0, 0, 1, latencyMs, latencyMs, latencyMs);
    } else {
      this.db
        .query(
          `INSERT INTO model_health (provider,model,window_start,successes,failures,total_ms,min_ms,max_ms)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(provider,model,window_start) DO UPDATE SET
             failures=failures+1,
             total_ms=total_ms+excluded.total_ms,
             min_ms=min(min_ms,excluded.min_ms),
             max_ms=max(max_ms,excluded.max_ms)`,
        )
        .run(provider, model, window, 0, 1, latencyMs, latencyMs, latencyMs);
    }
  }

  recordRateLimit(provider: string, model: string, statusCode: number): void {
    const now = Date.now() / 1000;
    this.db
      .query(
        `INSERT INTO rate_limit_events (ts,provider,model,status_code,retry_after)
         VALUES (?,?,?,?,NULL)`,
      )
      .run(now, provider, model, statusCode);
  }

  recordHealing(
    provider: string,
    model: string,
    event: string,
    prevStatus: string,
    newStatus: string,
    details: string,
  ): void {
    const now = Date.now() / 1000;
    this.db
      .query(
        `INSERT INTO healing_events (ts,provider,model,event,prev_status,new_status,details)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(now, provider, model, event, prevStatus, newStatus, details);
  }

  /** Aggregated health stats per provider for the last 30 minutes. */
  providerSummary(): Record<string, ProviderHealth> {
    const cutoff = Date.now() / 1000 - 1800;
    const rows = this.db
      .query(
        `SELECT provider,
                SUM(successes) AS successes,
                SUM(failures) AS failures,
                AVG(total_ms / max(successes+failures,1)) AS avg_ms,
                SUM(rate_limited) AS rate_limited
         FROM model_health WHERE window_start>=? GROUP BY provider`,
      )
      .all(cutoff) as Array<{
      provider: string;
      successes: number;
      failures: number;
      avg_ms: number | null;
      rate_limited: number;
    }>;
    const result: Record<string, ProviderHealth> = {};
    for (const r of rows) {
      const total = (r.successes ?? 0) + (r.failures ?? 0);
      result[r.provider] = {
        successes: r.successes ?? 0,
        failures: r.failures ?? 0,
        successRate: total > 0 ? (r.successes ?? 0) / total : 0,
        avgLatency: r.avg_ms ?? 0,
        rateLimited: r.rate_limited ?? 0,
      };
    }
    return result;
  }

  /** Session affinity lookup; returns [provider, model] or ["",""]. */
  stickyGet(sessionID: string, ttl: number): [string, string] {
    const cutoff = Date.now() / 1000 - ttl;
    const row = this.db
      .query(
        `SELECT provider, model FROM session_affinity
         WHERE session_id=? AND updated_at>=?`,
      )
      .get(sessionID, cutoff) as { provider: string; model: string } | null;
    if (!row) return ["", ""];
    return [row.provider, row.model];
  }

  stickySet(sessionID: string, provider: string, model: string): void {
    const now = Date.now() / 1000;
    this.db
      .query(
        `INSERT INTO session_affinity (session_id,provider,model,updated_at)
         VALUES (?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET
           provider=excluded.provider, model=excluded.model, updated_at=excluded.updated_at`,
      )
      .run(sessionID, provider, model, now);
  }

  /** Raw aggregation rows for debugging. */
  debugAgg(): Array<Record<string, unknown>> {
    return this.db
      .query(
        `SELECT model, provider, status, count(*) as cnt, avg(latency_ms) as avg_ms
         FROM requests GROUP BY model, provider, status ORDER BY cnt DESC LIMIT 20`,
      )
      .all() as Array<Record<string, unknown>>;
  }
}
