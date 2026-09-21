import { z } from "zod";
import { randomUUID } from "node:crypto";
import { connect, hash, type Run, Store } from "./db";
import { AppError } from "./errors";
import {
  IncidentArgs,
  IncidentResult,
  type IncidentInput,
  type IncidentOutput,
  type DecisionData,
} from "./schemas";
import type { AppConfig } from "./config";

export const toolDefinitions = {
  search_knowledge_base: {
    description:
      "Score all small-corpus FAQ documents together against the whole thread. Read-only; return matching IDs and content, never fabricate sources.",
    parameters: z.object({ conversation_id: z.string().uuid() }).strict(),
  },
  open_incident: {
    description:
      "Create one simulated support incident per conversation. Requires policy permission. Caller supplies a durable operation key; same key and arguments return the original incident. No refund, paging or account modification.",
    parameters: IncidentArgs,
  },
};

export interface IncidentProvider {
  create(key: string, input: IncidentInput): Promise<IncidentOutput>;
}
// Separate SQLite file represents an external service with its OWN idempotency store.
// Its commit cannot be rolled back with the caller's transaction.
export class MockIncidentProvider implements IncidentProvider {
  db: ReturnType<typeof connect>;
  constructor(
    path: string,
    private mode: AppConfig["INCIDENT_MODE"] = "normal",
    private latency = 30,
  ) {
    this.db = connect(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS incidents (operation_key TEXT PRIMARY KEY, argument_hash TEXT NOT NULL, result TEXT NOT NULL)",
    );
  }
  async create(key: string, input: IncidentInput) {
    const parsed = IncidentArgs.parse(input);
    await new Promise((resolve) => setTimeout(resolve, this.latency));
    const saved = this.db
      .prepare(
        "SELECT argument_hash,result FROM incidents WHERE operation_key=?",
      )
      .get(key) as { argument_hash: string; result: string } | undefined;
    if (saved) {
      if (saved.argument_hash !== hash(parsed))
        throw new AppError(
          409,
          "provider_idempotency_conflict",
          "Incident key has different arguments.",
        );
      return IncidentResult.parse(JSON.parse(saved.result));
    }
    if (this.mode === "fail_before_commit")
      throw new Error("Simulated provider outage before commit");
    const result: IncidentOutput = {
      incident_id: `INC-${randomUUID()}`,
      status: "open",
      simulated: true,
    };
    this.db
      .prepare("INSERT OR IGNORE INTO incidents VALUES (?,?,?)")
      .run(key, hash(parsed), JSON.stringify(result));
    if (this.mode === "timeout_after_commit")
      throw new Error("Simulated timeout after remote commit");
    const actual = this.db
      .prepare(
        "SELECT argument_hash,result FROM incidents WHERE operation_key=?",
      )
      .get(key) as { argument_hash: string; result: string };
    if (actual.argument_hash !== hash(parsed))
      throw new AppError(
        409,
        "provider_idempotency_conflict",
        "Incident key has different arguments.",
      );
    return IncidentResult.parse(JSON.parse(actual.result));
  }
  close() {
    this.db.close();
  }
}

export async function executeIncident(
  store: Store,
  provider: IncidentProvider,
  run: Run,
  decision: DecisionData,
): Promise<IncidentOutput> {
  store.assertOwner(run);
  if (!decision.incident_allowed)
    throw new AppError(
      403,
      "action_denied",
      "Policy does not permit incident creation.",
    );
  const key = `incident:${run.conversation_id}:v1`;
  const input: IncidentInput = {
    conversation_id: run.conversation_id,
    region: store.state(run.conversation_id).customer.region,
    summary:
      "Reported ongoing multi-user loss of core service; requires human verification.",
  };
  store.db
    .prepare(
      "INSERT OR IGNORE INTO side_effects (operation_key,conversation_id,status,arguments) VALUES (?,?,'pending',?)",
    )
    .run(key, run.conversation_id, JSON.stringify(input));
  const effect = store.db
    .prepare(
      "SELECT status,arguments,result FROM side_effects WHERE operation_key=?",
    )
    .get(key) as { status: string; arguments: string; result: string | null };
  if (effect.status === "succeeded") {
    const result = IncidentResult.parse(JSON.parse(effect.result!));
    store.audit(run.id, "tool.reused", {
      tool: "open_incident",
      operation_key: key,
      result,
    });
    return result;
  }
  store.db
    .prepare(
      "UPDATE side_effects SET attempts=attempts+1,status='pending' WHERE operation_key=?",
    )
    .run(key);
  store.audit(run.id, "tool.started", {
    tool: "open_incident",
    operation_key: key,
    arguments: JSON.parse(effect.arguments),
  });
  try {
    const result = IncidentResult.parse(
      await provider.create(key, JSON.parse(effect.arguments)),
    );
    store.assertOwner(run);
    store.db
      .prepare(
        "UPDATE side_effects SET status='succeeded',result=? WHERE operation_key=?",
      )
      .run(JSON.stringify(result), key);
    store.audit(run.id, "tool.succeeded", {
      tool: "open_incident",
      operation_key: key,
      result,
    });
    return result;
  } catch {
    // A timeout never proves the provider did nothing. Retry only with the SAME key.
    store.assertOwner(run);
    store.db
      .prepare("UPDATE side_effects SET status='unknown' WHERE operation_key=?")
      .run(key);
    store.audit(run.id, "tool.unknown", {
      tool: "open_incident",
      operation_key: key,
      reason:
        "No validated acknowledgement; reconcile by replaying the same operation key.",
    });
    throw new AppError(
      503,
      "incident_outcome_unknown",
      "Incident outcome is not confirmed. Retry the original request with the same Idempotency-Key.",
    );
  }
}
