import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { TERMINAL } from "./types.ts";
import type { FlowEvent, RunState } from "./types.ts";

export interface StoredEvent extends FlowEvent { id: number; ts: number; processed: boolean }
export interface OutboxRow { id: number; run_id: string; role: string; text: string; entry_id: string | null; created: number; attempts: number }

export function statePath(): string {
  return process.env.FLOWS_STATE || join(homedir(), ".local", "state", "flows", "flows.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, process TEXT NOT NULL, n INTEGER NOT NULL, status TEXT NOT NULL,
  state TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, type TEXT NOT NULL, run_id TEXT,
  entry_id TEXT, outcome TEXT, data TEXT NOT NULL, source TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id);
CREATE INDEX IF NOT EXISTS events_unprocessed ON events(processed);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
  entry_id TEXT, created REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent REAL);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY, status TEXT NOT NULL, status_at REAL NOT NULL);
`;

// node:sqlite rows are untyped records
type Row = Record<string, any>;
const OPEN = `status NOT IN (${TERMINAL.map((s) => `'${s}'`).join(", ")})`;

function toEvent(row: Row): StoredEvent {
  return {
    id: Number(row.id), ts: Number(row.ts), type: row.type,
    run: row.run_id ?? undefined, entry: row.entry_id ?? undefined, outcome: row.outcome ?? undefined,
    data: JSON.parse(row.data), source: row.source, processed: Boolean(row.processed),
    ...(row.subscription ? { subscription: row.subscription } : {}),
  };
}

export class Store {
  db: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    // added after the first release: older databases lack it
    const cols = this.db.prepare("PRAGMA table_info(events)").all() as Row[];
    if (!cols.some((c) => c.name === "subscription")) this.db.exec("ALTER TABLE events ADD COLUMN subscription TEXT");
  }

  close(): void { this.db.close(); }

  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth = 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  addEvent(e: FlowEvent, ts = Date.now()): number {
    const r = this.db
      .prepare("INSERT INTO events (ts, type, run_id, entry_id, outcome, data, source, subscription) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ts, e.type, e.run ?? null, e.entry ?? null, e.outcome ?? null, JSON.stringify(e.data ?? {}), e.source, e.subscription ?? null);
    return Number(r.lastInsertRowid);
  }

  event(id: number): StoredEvent | null {
    const row = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as Row | undefined;
    return row ? toEvent(row) : null;
  }

  unprocessed(): StoredEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE processed = 0 ORDER BY id").all() as Row[]).map(toEvent);
  }

  markProcessed(id: number): void {
    this.db.prepare("UPDATE events SET processed = 1 WHERE id = ?").run(id);
  }

  runEvents(runId: string, limit = 300): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE run_id = ? OR json_extract(data, '$.run') = ? ORDER BY id DESC LIMIT ?")
      .all(runId, runId, limit) as Row[];
    return rows.map(toEvent);
  }

  nextRunNumber(process: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(n), 0) + 1 AS n FROM runs WHERE process = ?").get(process) as Row;
    return Number(row.n);
  }

  createRun(state: RunState, n: number, now = Date.now()): void {
    this.db
      .prepare("INSERT INTO runs (id, process, n, status, state, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(state.id, state.process, n, state.status, JSON.stringify(state), now, now);
  }

  saveRun(state: RunState, now = Date.now()): void {
    const r = this.db.prepare("UPDATE runs SET status = ?, state = ?, updated = ? WHERE id = ?")
      .run(state.status, JSON.stringify(state), now, state.id);
    if (Number(r.changes) === 0) throw new Error(`no run ${state.id}`);
  }

  getRun(id: string): RunState | null {
    const row = this.db.prepare("SELECT state FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? JSON.parse(row.state) : null;
  }

  openRuns(): RunState[] {
    return (this.db.prepare(`SELECT state FROM runs WHERE ${OPEN} ORDER BY created`).all() as Row[]).map((r) => JSON.parse(r.state));
  }

  listRuns(limit = 200): RunState[] {
    const rows = this.db.prepare(`SELECT state FROM runs ORDER BY (${OPEN}) DESC, updated DESC LIMIT ?`).all(limit) as Row[];
    return rows.map((r) => JSON.parse(r.state));
  }

  runBySession(session: string): { run: RunState; role: string } | null {
    for (const run of this.openRuns()) {
      for (const [role, s] of Object.entries(run.roles)) if (s === session) return { run, role };
    }
    return null;
  }

  enqueue(runId: string, role: string, text: string, entry: string | null = null, now = Date.now()): number {
    const r = this.db.prepare("INSERT INTO outbox (run_id, role, text, entry_id, created) VALUES (?, ?, ?, ?, ?)").run(runId, role, text, entry, now);
    return Number(r.lastInsertRowid);
  }

  pendingOutbox(): OutboxRow[] {
    const rows = this.db.prepare("SELECT id, run_id, role, text, entry_id, created, attempts FROM outbox WHERE sent IS NULL ORDER BY id").all() as Row[];
    return rows.map((r) => ({
      id: Number(r.id), run_id: r.run_id, role: r.role, text: r.text, entry_id: r.entry_id ?? null,
      created: Number(r.created), attempts: Number(r.attempts),
    }));
  }

  markSent(id: number, now = Date.now()): void {
    this.db.prepare("UPDATE outbox SET sent = ? WHERE id = ?").run(now, id);
  }

  bumpOutbox(id: number): number {
    this.db.prepare("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?").run(id);
    return Number((this.db.prepare("SELECT attempts FROM outbox WHERE id = ?").get(id) as Row).attempts);
  }

  dropOutbox(runId: string): void {
    this.db.prepare("DELETE FROM outbox WHERE run_id = ? AND sent IS NULL").run(runId);
  }

  setSessionStatus(session: string, status: string, at = Date.now()): void {
    this.db
      .prepare("INSERT INTO sessions (session_id, status, status_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET status = excluded.status, status_at = excluded.status_at")
      .run(session, status, at);
  }

  sessionStatus(session: string): string | null {
    const row = this.db.prepare("SELECT status FROM sessions WHERE session_id = ?").get(session) as Row | undefined;
    return row ? row.status : null;
  }
}
