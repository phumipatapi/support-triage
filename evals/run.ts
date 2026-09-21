import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import cases from "./cases.json";
import samples from "../data/sample-tickets.json";
import { Store } from "../lib/db";
import { readConfig } from "../lib/config";
import { createModels } from "../lib/models";
import { MockIncidentProvider } from "../lib/tools";
import { TriageService } from "../lib/triage";

const live = process.argv.includes("--live");
const config = readConfig(
  live ? process.env : { DECISION_PROVIDER: "mock", REPLY_PROVIDER: "mock" },
);
if (live && config.DECISION_PROVIDER === "mock")
  throw new Error(
    "--live requires DECISION_PROVIDER=jev or openai and configured keys.",
  );
const dir = mkdtempSync(join(tmpdir(), "triage-eval-"));
const store = new Store(join(dir, "triage.sqlite"));
const incidents = new MockIncidentProvider(
  join(dir, "incidents.sqlite"),
  "normal",
  0,
);
const service = new TriageService(store, createModels(config), incidents);
const results: {
  id: string;
  passed: boolean;
  latency_ms: number;
  checks: Record<string, boolean>;
  actual?: unknown;
  error?: string;
}[] = [];
const log = console.log;
console.log = () => {}; // Persisted audit remains available during evaluation; keep summary readable.
try {
  for (const c of cases) {
    const started = performance.now();
    try {
      const ticket =
        c.sample !== undefined
          ? samples[c.sample].ticket
          : {
              customer: { plan: "pro", region: "Thailand" },
              messages: [{ content: c.content }],
            };
      let result = await service.submit(ticket, randomUUID());
      if (c.followup)
        result = await service.submit(
          { role: "operator", content: c.followup },
          randomUUID(),
          result.body.conversation_id,
        );
      const d = result.body.decision;
      const checks = {
        urgency: d.urgency === c.expected.urgency,
        action: d.action === c.expected.action,
        language: d.extracted.language === c.expected.language,
        incident: Boolean(result.body.incident) === c.expected.incident,
        retrieval: c.expected.faq
          ? d.knowledge_ids.includes(c.expected.faq)
          : true,
        no_financial_tools: d.tools_called.every((t: string) =>
          ["search_knowledge_base", "open_incident"].includes(t),
        ),
      };
      results.push({
        id: c.id,
        passed: Object.values(checks).every(Boolean),
        latency_ms: Math.round(performance.now() - started),
        checks,
        actual: d,
      });
    } catch (error) {
      results.push({
        id: c.id,
        passed: false,
        latency_ms: Math.round(performance.now() - started),
        checks: {},
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
  const percentile = (fraction: number) => {
    const times = results.map((r) => r.latency_ms).sort((a, b) => a - b);
    return times[Math.max(0, Math.ceil(times.length * fraction) - 1)];
  };
  const rate = (name: string) =>
    results.filter((r) => r.checks[name]).length / results.length;
  const modelEvents = store.db
    .prepare(
      "SELECT data FROM audit WHERE event IN ('model.assessed','model.replied')",
    )
    .all() as { data: string }[];
  const usage = modelEvents
    .map((row) => JSON.parse(row.data).metadata)
    .filter(Boolean);
  const report = {
    created_at: new Date().toISOString(),
    mode: config.DECISION_PROVIDER,
    interpretation: live
      ? "Small live end-to-end evaluation; labels are authored expectations, not universal ground truth."
      : "OFFLINE MOCK BASELINE ONLY. This measures harness/policy behavior, NOT Jev/GPT quality.",
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    urgency_accuracy: rate("urgency"),
    action_accuracy: rate("action"),
    language_accuracy: rate("language"),
    incident_accuracy: rate("incident"),
    latency_ms: { p50: percentile(0.5), p95: percentile(0.95) },
    model_usage: usage,
    results,
  };
  mkdirSync("evals/reports", { recursive: true });
  const path = `evals/reports/${live ? config.DECISION_PROVIDER : "offline"}.json`;
  writeFileSync(path, JSON.stringify(report, null, 2));
  log(
    JSON.stringify(
      {
        ...report,
        model_usage: undefined,
        results: results.map((r) => ({
          id: r.id,
          passed: r.passed,
          failed_checks: Object.entries(r.checks)
            .filter(([, v]) => !v)
            .map(([k]) => k),
          error: r.error,
        })),
        report: path,
      },
      null,
      2,
    ),
  );
  if (results.some((r) => !r.passed)) process.exitCode = 1;
} finally {
  console.log = log;
  store.close();
  incidents.close();
  rmSync(dir, { recursive: true, force: true });
}
