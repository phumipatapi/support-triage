import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AppError } from "./errors";
import type {
  AssessmentData,
  DecisionData,
  MessageInput,
  State,
  StoredMessage,
  TicketInput,
} from "./schemas";

export const LEASE_MS = 120_000; // Provider calls are individually bounded to 20s, without SDK retries.
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function connect(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}
export type Run = {
  id: string;
  conversation_id: string;
  scope: string;
  request_key: string;
  request_hash: string;
  status: "running" | "retryable" | "completed";
  owner: string;
  lease_until: number;
  assessment: string | null;
  decision: string | null;
  response: string | null;
  error: string | null;
  created_at: string;
};

export class Store {
  db: Database.Database;
  constructor(path: string) {
    this.db = connect(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, customer TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        scope TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
        status TEXT NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL,
        assessment TEXT, decision TEXT, response TEXT, error TEXT, created_at TEXT NOT NULL,
        UNIQUE(scope, request_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_unfinished_run ON runs(conversation_id)
        WHERE status IN ('running','retryable');
      CREATE TABLE IF NOT EXISTS messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id), run_id TEXT NOT NULL REFERENCES runs(id),
        role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
        event TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS side_effects (
        operation_key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        status TEXT NOT NULL, arguments TEXT NOT NULL, result TEXT, attempts INTEGER NOT NULL DEFAULT 0
      );
      PRAGMA user_version = 1;
    `);
  }
  run(id: string): Run {
    return this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as Run;
  }
  begin(
    scope: string,
    key: string,
    payload: TicketInput | MessageInput,
    conversationId?: string,
  ) {
    return this.db
      .transaction(() => {
        const fingerprint = hash(payload);
        const old = this.db
          .prepare("SELECT * FROM runs WHERE scope=? AND request_key=?")
          .get(scope, key) as Run | undefined;
        if (old) {
          if (old.request_hash !== fingerprint)
            throw new AppError(
              409,
              "idempotency_conflict",
              "This key was already used with different content.",
            );
          if (old.status === "completed") return { run: old, replay: true };
          if (old.status === "running" && old.lease_until > Date.now())
            throw new AppError(
              409,
              "run_in_progress",
              "Retry the same request after the active run finishes.",
              { conversation_id: old.conversation_id, run_id: old.id },
            );
          const owner = randomUUID();
          this.db
            .prepare(
              "UPDATE runs SET status='running', owner=?, lease_until=?, error=NULL WHERE id=?",
            )
            .run(owner, Date.now() + LEASE_MS, old.id);
          return { run: this.run(old.id), replay: false };
        }
        const id = conversationId ?? randomUUID();
        if (conversationId) {
          this.state(id); // Also gives a consistent 404 before checking pending work.
          const active = this.db
            .prepare(
              "SELECT id FROM runs WHERE conversation_id=? AND status!='completed'",
            )
            .get(id) as { id: string } | undefined;
          if (active)
            throw new AppError(
              409,
              "conversation_busy",
              "Finish or retry the previous request with its original key first.",
              { run_id: active.id },
            );
          const state = this.state(id);
          const content = (payload as MessageInput).content;
          if (
            state.messages.length >= 60 ||
            state.messages.reduce((n, m) => n + m.content.length, 0) +
              content.length >
              60000
          )
            throw new AppError(
              422,
              "conversation_limit",
              "This demo allows up to 60 messages / 60,000 characters per conversation.",
            );
        } else {
          const ticket = payload as TicketInput;
          if (ticket.messages.reduce((n, m) => n + m.content.length, 0) > 60000)
            throw new AppError(
              422,
              "conversation_limit",
              "Thread exceeds 60,000 characters.",
            );
          this.db
            .prepare("INSERT INTO conversations VALUES (?,?,?)")
            .run(id, JSON.stringify(ticket.customer), new Date().toISOString());
        }
        const runId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO runs (id,conversation_id,scope,request_key,request_hash,status,owner,lease_until,created_at)
        VALUES (?,?,?,?,?,'running',?,?,?)`,
          )
          .run(
            runId,
            id,
            scope,
            key,
            fingerprint,
            randomUUID(),
            Date.now() + LEASE_MS,
            new Date().toISOString(),
          );
        const messages = conversationId
          ? [payload as MessageInput]
          : (payload as TicketInput).messages;
        for (const m of messages)
          this.addMessage(id, runId, m.role, m.content, m.timestamp);
        this.audit(runId, "run.started", {
          conversation_id: id,
          request_hash: fingerprint,
        });
        return { run: this.run(runId), replay: false };
      })
      .immediate();
  }
  addMessage(
    conversation: string,
    run: string,
    role: string,
    content: string,
    timestamp = new Date().toISOString(),
  ) {
    this.db
      .prepare(
        "INSERT INTO messages (id,conversation_id,run_id,role,content,timestamp) VALUES (?,?,?,?,?,?)",
      )
      .run(randomUUID(), conversation, run, role, content, timestamp);
  }
  state(id: string): State {
    const row = this.db
      .prepare("SELECT customer FROM conversations WHERE id=?")
      .get(id) as { customer: string } | undefined;
    if (!row) throw new AppError(404, "not_found", "Conversation not found.");
    const messages = this.db
      .prepare(
        "SELECT id,role,content,timestamp FROM messages WHERE conversation_id=? ORDER BY sequence",
      )
      .all(id) as StoredMessage[];
    return { customer: JSON.parse(row.customer), messages };
  }
  assertOwner(run: Run) {
    const current = this.run(run.id);
    if (
      current.owner !== run.owner ||
      current.status !== "running" ||
      current.lease_until <= Date.now()
    )
      throw new AppError(
        409,
        "lease_lost",
        "This run lease expired. Retry the original request.",
      );
  }
  checkpoint(run: Run, assessment: AssessmentData, decision: DecisionData) {
    this.assertOwner(run);
    this.db
      .prepare(
        "UPDATE runs SET assessment=?, decision=? WHERE id=? AND owner=?",
      )
      .run(
        JSON.stringify(assessment),
        JSON.stringify(decision),
        run.id,
        run.owner,
      );
  }
  audit(runId: string, event: string, data: unknown) {
    const at = new Date().toISOString();
    const row = this.db
      .prepare(
        "INSERT INTO audit (run_id,event,data,created_at) VALUES (?,?,?,?)",
      )
      .run(runId, event, JSON.stringify(data), at);
    // Content stays in SQLite; log references prevent leaking raw customer text into stdout.
    console.log(
      JSON.stringify({
        timestamp: at,
        event,
        run_id: runId,
        audit_id: Number(row.lastInsertRowid),
      }),
    );
  }
  complete(run: Run, decision: DecisionData, response: unknown, reply: string) {
    this.db
      .transaction(() => {
        this.assertOwner(run);
        this.addMessage(run.conversation_id, run.id, "assistant", reply);
        this.db
          .prepare(
            "UPDATE runs SET status='completed',decision=?,response=?,lease_until=0 WHERE id=? AND owner=?",
          )
          .run(
            JSON.stringify(decision),
            JSON.stringify(response),
            run.id,
            run.owner,
          );
        this.audit(run.id, "run.completed", { decision });
      })
      .immediate();
  }
  fail(run: Run, code: string) {
    this.db
      .prepare(
        "UPDATE runs SET status='retryable',error=?,lease_until=0 WHERE id=? AND owner=? AND status='running'",
      )
      .run(code, run.id, run.owner);
    this.audit(run.id, "run.retryable", { code });
  }
  history(id: string) {
    const state = this.state(id);
    const runs = this.db
      .prepare("SELECT * FROM runs WHERE conversation_id=? ORDER BY rowid")
      .all(id) as Run[];
    const audit = this.db
      .prepare(
        "SELECT a.* FROM audit a JOIN runs r ON a.run_id=r.id WHERE r.conversation_id=? ORDER BY a.sequence",
      )
      .all(id) as { data: string }[];
    const effects = this.db
      .prepare("SELECT * FROM side_effects WHERE conversation_id=?")
      .all(id) as { arguments: string; result: string | null }[];
    return {
      conversation_id: id,
      ...state,
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        created_at: r.created_at,
        error: r.error,
        assessment: r.assessment ? JSON.parse(r.assessment) : null,
        decision: r.decision ? JSON.parse(r.decision) : null,
      })),
      audit: audit.map((a) => ({ ...a, data: JSON.parse(a.data) })),
      side_effects: effects.map((e) => ({
        ...e,
        arguments: JSON.parse(e.arguments),
        result: e.result ? JSON.parse(e.result) : null,
      })),
    };
  }
  close() {
    this.db.close();
  }
}
