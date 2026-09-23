import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import samples from "../data/sample-tickets.json";
import { Store, LEASE_MS } from "../lib/db";
import { createModels, type Models } from "../lib/models";
import { readConfig } from "../lib/config";
import { MockIncidentProvider } from "../lib/tools";
import { TriageService } from "../lib/triage";
import { handle } from "../lib/http";
import { AppError } from "../lib/errors";
import { finalizeReply } from "../lib/reply-context";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((f) => f());
  vi.restoreAllMocks();
});
function setup(
  mode: "normal" | "timeout_after_commit" | "fail_before_commit" = "normal",
  wrap?: (m: Models) => Models,
) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const dir = mkdtempSync(join(tmpdir(), "triage-test-"));
  const path = join(dir, "main.sqlite");
  const providerPath = join(dir, "provider.sqlite");
  const store = new Store(path);
  const provider = new MockIncidentProvider(providerPath, mode, 0);
  const models = createModels(
    readConfig({ DECISION_PROVIDER: "mock", REPLY_PROVIDER: "mock" }),
  );
  const service = new TriageService(
    store,
    wrap ? wrap(models) : models,
    provider,
  );
  cleanup.push(() => {
    store.close();
    provider.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { service, store, provider, path, providerPath };
}
const outage = samples[1].ticket;
describe("durable workflow", () => {
  it("triages the three supplied threads without erasing unresolved issues", async () => {
    const { service } = setup();
    const expected = [
      ["high", "route_to_specialist"],
      ["critical", "escalate_to_human"],
      ["medium", "route_to_specialist"],
    ];
    for (const [i, s] of samples.entries()) {
      const { body } = await service.submit(s.ticket, `sample-${i}`);
      expect([body.decision.urgency, body.decision.action]).toEqual(
        expected[i],
      );
      expect(Boolean(body.incident)).toBe(i === 1);
    }
  });
  it("replays the same response and never duplicates messages or effects", async () => {
    const { service, store, provider } = setup();
    const first = await service.submit(outage, "same");
    const second = await service.submit(outage, "same");
    expect(second.replay).toBe(true);
    expect(second.body).toEqual(first.body);
    expect(store.state(first.body.conversation_id).messages).toHaveLength(5);
    expect(
      provider.db.prepare("SELECT COUNT(*) n FROM incidents").get(),
    ).toEqual({ n: 1 });
    await expect(
      service.submit(samples[0].ticket, "same"),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
  });
  it("persists a guarded fallback after an incident and replays it without repeating work", async () => {
    const replyCalls = vi.fn();
    const { service, store, provider } = setup("normal", (models) => ({
      ...models,
      reply: async (input) => {
        replyCalls();
        const { validation, ...reply } = finalizeReply(
          {
            reply: "เรากำลังส่งเรื่องให้ทีมตรวจสอบ",
            citation_ids: ["availability"],
          },
          input,
        );
        return {
          ...reply,
          metadata: {
            provider: "openai",
            model: "test-reply-model",
            usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
            ...validation,
          },
        };
      },
    }));
    const first = await service.submit(outage, "fallback-replay");
    const replay = await service.submit(outage, "fallback-replay");
    expect(first.body.reply_source).toBe("policy_fallback");
    expect(first.body.incident).toMatchObject({ status: "open", simulated: true });
    expect(first.body.citation_ids).toEqual([]);
    expect(first.body.reply).not.toContain("เรากำลังส่งเรื่อง");
    expect(replay.replay).toBe(true);
    expect(replay.body).toEqual(first.body);
    expect(replyCalls).toHaveBeenCalledTimes(1);
    expect(provider.db.prepare("SELECT COUNT(*) n FROM incidents").get()).toEqual({ n: 1 });
    const audit = store.db.prepare("SELECT data FROM audit WHERE run_id=? AND event='model.replied'")
      .all(first.body.run_id) as { data: string }[];
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].data).metadata).toMatchObject({
      provider: "openai",
      model: "test-reply-model",
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      reply_source: "policy_fallback",
      rejected_draft_code: "unsupported_reply_claim",
    });
  });
  it("recovers from remote commit followed by timeout, retaining the same incident", async () => {
    const { service, store, provider } = setup("timeout_after_commit");
    await expect(service.submit(outage, "timeout")).rejects.toMatchObject({
      status: 503,
      code: "incident_outcome_unknown",
    });
    expect(
      provider.db.prepare("SELECT COUNT(*) n FROM incidents").get(),
    ).toEqual({ n: 1 });
    expect(store.db.prepare("SELECT status FROM side_effects").get()).toEqual({
      status: "unknown",
    });
    const result = await service.submit(outage, "timeout");
    expect(result.body.incident.status).toBe("open");
    expect(
      store.db.prepare("SELECT status,attempts FROM side_effects").get(),
    ).toEqual({ status: "succeeded", attempts: 2 });
    expect(
      provider.db.prepare("SELECT COUNT(*) n FROM incidents").get(),
    ).toEqual({ n: 1 });
  });
  it("retains unknown status on provider failure without claiming success", async () => {
    const { service, store, provider } = setup("fail_before_commit");
    await expect(service.submit(outage, "fail")).rejects.toMatchObject({
      status: 503,
    });
    expect(
      provider.db.prepare("SELECT COUNT(*) n FROM incidents").get(),
    ).toEqual({ n: 0 });
    expect(
      store.db
        .prepare("SELECT COUNT(*) n FROM messages WHERE role='assistant'")
        .get(),
    ).toEqual({ n: 0 });
  });
  it("reuses a completed effect when GPT reply fails, with no repeated assessment", async () => {
    let replies = 0;
    const assess = vi.fn();
    const { service, provider } = setup("normal", (m) => ({
      ...m,
      assess: async (s) => {
        assess();
        return m.assess(s);
      },
      reply: async (i) => {
        if (++replies === 1) throw new Error("GPT unavailable");
        return m.reply(i);
      },
    }));
    await expect(service.submit(outage, "reply-fail")).rejects.toMatchObject({
      status: 503,
    });
    await service.submit(outage, "reply-fail");
    expect(assess).toHaveBeenCalledTimes(1);
    expect(
      provider.db.prepare("SELECT COUNT(*) n FROM incidents").get(),
    ).toEqual({ n: 1 });
  });
  it("rejects simultaneous duplicates while the first call is running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { service } = setup("normal", (m) => ({
      ...m,
      assess: async (s) => {
        await gate;
        return m.assess(s);
      },
    }));
    const first = service.submit(outage, "parallel");
    await expect(service.submit(outage, "parallel")).rejects.toMatchObject({
      status: 409,
      code: "run_in_progress",
    });
    release();
    await first;
  });
  it("persists history across connections and resumes an expired run without re-inserting input", async () => {
    const { store, path, provider } = setup();
    const ticket = (await import("../lib/schemas")).Ticket.parse(outage);
    const { run } = store.begin("ticket", "crashed", ticket);
    store.db
      .prepare("UPDATE runs SET lease_until=? WHERE id=?")
      .run(Date.now() - LEASE_MS, run.id);
    const fresh = new Store(path);
    try {
      const service = new TriageService(
        fresh,
        createModels(
          readConfig({ DECISION_PROVIDER: "mock", REPLY_PROVIDER: "mock" }),
        ),
        provider,
      );
      const result = await service.submit(outage, "crashed");
      expect(result.body.conversation_id).toBe(run.conversation_id);
      expect(fresh.history(run.conversation_id).messages).toHaveLength(5);
      expect(fresh.history(run.conversation_id).audit.length).toBeGreaterThan(
        4,
      );
    } finally {
      fresh.close();
    }
  });
  it("continues conversation and deduplicates incident across distinct turns", async () => {
    const { service, store, provider } = setup();
    const first = await service.submit(outage, "start");
    const next = await service.submit(
      { role: "operator", content: "ตอนนี้ทั้งทีมยังเข้าไม่ได้ครับ" },
      "follow",
      first.body.conversation_id,
    );
    expect(next.body.incident.incident_id).toBe(
      first.body.incident.incident_id,
    );
    expect(store.state(first.body.conversation_id).messages).toHaveLength(7);
    expect(
      provider.db.prepare("SELECT COUNT(*) n FROM incidents").get(),
    ).toEqual({ n: 1 });
  });
  it("retains an existing incident when a follow-up no longer permits creating one", async () => {
    let assessments = 0;
    const reply = vi.fn();
    const { service, store, provider } = setup("normal", (m) => ({
      ...m,
      assess: async (state) => {
        const result = await m.assess(state);
        if (++assessments > 1) {
          result.assessment.ongoing_outage = 0;
          result.assessment.core_work_blocked = 0;
          result.assessment.urgency = "low";
        }
        return result;
      },
      reply: async (input) => {
        reply(input);
        return m.reply(input);
      },
    }));
    const first = await service.submit(outage, "incident-start");
    const next = await service.submit(
      {
        role: "customer",
        content: "Everyone can access the app again. What happened?",
      },
      "incident-resolved",
      first.body.conversation_id,
    );
    expect(next.body.decision.incident_allowed).toBe(false);
    expect(next.body.decision.tools_called).not.toContain("open_incident");
    expect(next.body.incident).toEqual(first.body.incident);
    expect(reply.mock.calls[1][0].incident).toEqual(first.body.incident);
    expect(store.db.prepare("SELECT attempts FROM side_effects").get()).toEqual(
      { attempts: 1 },
    );
    expect(
      provider.db.prepare("SELECT COUNT(*) n FROM incidents").get(),
    ).toEqual({ n: 1 });
    const retained = store
      .history(first.body.conversation_id)
      .audit.find(
        (entry: Record<string, unknown>) => entry.event === "incident.retained",
      );
    expect(retained?.data).toMatchObject({
      source: "previous_run",
      tool_executed: false,
    });
  });
  it("fences a stale worker without falsely auditing the replacement as retryable", async () => {
    const { service, store } = setup();
    const ticket = (await import("../lib/schemas")).Ticket.parse(outage);
    const { run: stale } = store.begin("ticket", "fenced", ticket);
    store.db
      .prepare("UPDATE runs SET lease_until=? WHERE id=?")
      .run(Date.now() - 1, stale.id);
    await service.submit(outage, "fenced");
    expect(() => store.assertOwner(stale)).toThrowError(
      "This run lease expired",
    );
    store.fail(stale, "late_worker_failure");
    expect(store.run(stale.id).status).toBe("completed");
    expect(
      store.db
        .prepare("SELECT COUNT(*) n FROM audit WHERE event='run.retryable'")
        .get(),
    ).toEqual({ n: 0 });
    expect(store.state(stale.conversation_id).messages).toHaveLength(5);
  });
  it("blocks a new turn while a failed run is unresolved", async () => {
    const { service, store } = setup("fail_before_commit");
    await expect(service.submit(outage, "pending")).rejects.toMatchObject({
      status: 503,
    });
    const row = store.db.prepare("SELECT conversation_id FROM runs").get() as {
      conversation_id: string;
    };
    await expect(
      service.submit(
        { content: "Any update?" },
        "different",
        row.conversation_id,
      ),
    ).rejects.toMatchObject({ status: 409, code: "conversation_busy" });
    expect(store.state(row.conversation_id).messages).toHaveLength(4);
  });
  it("rejects attempts to reuse a provider key for different arguments", async () => {
    const { provider } = setup();
    const args = {
      conversation_id: randomUUID(),
      region: "Thailand",
      summary: "Reported outage",
    };
    await provider.create("op-1", args);
    await expect(
      provider.create("op-1", { ...args, region: "Europe" }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("HTTP contract", () => {
  it("preserves the provider backoff hint through the run and HTTP boundary", async () => {
    const { service } = setup("normal", (m) => ({
      ...m,
      assess: async () => {
        throw new AppError(503, "provider_unavailable", "Rate limited", {
          retry_after_seconds: 7,
        });
      },
    }));
    const response = await handle(
      new Request("http://localhost/api/tickets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "limited",
        },
        body: JSON.stringify(outage),
      }),
      undefined,
      () => service,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("7");
    expect((await response.json()).error.details).toMatchObject({
      retry_after_seconds: 7,
      retryable: true,
    });
  });
  it("validates media, JSON, fields, keys and missing conversations", async () => {
    const { service } = setup();
    const request = (
      body: string,
      headers: Record<string, string> = {
        "content-type": "application/json",
        "idempotency-key": "http",
      },
    ) =>
      new Request("http://localhost/api/tickets", {
        method: "POST",
        headers,
        body,
      });
    expect(
      (await handle(request("{}", {}), undefined, () => service)).status,
    ).toBe(415);
    expect(
      (
        await handle(
          request("{}", { "content-type": "application/json-invalid" }),
          undefined,
          () => service,
        )
      ).status,
    ).toBe(415);
    expect((await handle(request("{"), undefined, () => service)).status).toBe(
      400,
    );
    expect((await handle(request("{}"), undefined, () => service)).status).toBe(
      422,
    );
    expect(
      (
        await handle(
          request(JSON.stringify(outage), {
            "content-type": "application/json",
          }),
          undefined,
          () => service,
        )
      ).status,
    ).toBe(400);
    expect(
      (await handle(request("x".repeat(130 * 1024)), undefined, () => service))
        .status,
    ).toBe(413);
    const notFound = await handle(
      new Request("http://localhost"),
      randomUUID(),
      () => service,
    );
    expect(notFound.status).toBe(404);
    const first = await handle(
      request(JSON.stringify(outage)),
      undefined,
      () => service,
    );
    expect(first.status).toBe(201);
    expect(first.headers.get("x-request-id")).toBeTruthy();
    const body = await first.json();
    const history = await handle(
      new Request("http://localhost"),
      body.conversation_id,
      () => service,
    );
    expect(history.status).toBe(200);
    expect((await history.json()).side_effects).toHaveLength(1);
  });
});
