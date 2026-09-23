import { describe, expect, it, vi } from "vitest";
import {
  buildQuestions,
  createModels,
  mockAssessment,
  parseJev,
  faqs,
} from "../lib/models";
import { readConfig } from "../lib/config";
import { decide } from "../lib/policy";
import { type State } from "../lib/schemas";

const state: State = {
  customer: { plan: "pro", region: "Thailand" },
  messages: [
    {
      id: "1",
      role: "customer",
      content: "How do I enable dark mode?",
      timestamp: "2026-09-21T00:00:00Z",
    },
  ],
};
function jevFixture() {
  const mock = mockAssessment(state);
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(buildQuestions())) {
    if (q.type === "choice") {
      const choice = mock[id as keyof typeof mock];
      answers[id] = {
        type: "choice",
        choice,
        confidence: 0.95,
        probabilities: Object.fromEntries(
          Object.keys(q.criteria).map((k) => [k, k === choice ? 1 : 0]),
        ),
      };
    } else
      answers[id] = {
        type: "noul",
        noul: id.startsWith("faq_")
          ? mock.faq_scores[Number(id.slice(4))].relevance
          : id.startsWith("supports_")
            ? mock.faq_scores[Number(id.slice(9))].relevance >= 0.75
              ? mock.knowledge_sufficient
              : 0.05
            : mock[id as keyof typeof mock],
      };
  }
  return {
    model: "jev-contract-fixture",
    answers,
    usage: { input_tokens: 100, output_tokens: 40 },
  };
}
describe("Jev wire contract (simulated HTTP, not live model evaluation)", () => {
  it("batches ALL FAQ and classification questions into one request", async () => {
    const fetcher = vi.fn(async () => Response.json(jevFixture()));
    const models = createModels(
      readConfig({
        DECISION_PROVIDER: "jev",
        REPLY_PROVIDER: "openai",
        OPENAI_API_KEY: "test",
        TYPESAFE_API_KEY: "test",
      }),
      fetcher,
    );
    const result = await models.assess(state);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe("https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(calls[0][1].body as string);
    expect(body.state.faq).toHaveLength(faqs.length);
    expect(
      Object.keys(body.questions).filter((k) => k.startsWith("faq_")),
    ).toHaveLength(faqs.length);
    expect(result.assessment.faq_scores).toHaveLength(faqs.length);
    expect(result.metadata.model).toBe("jev-contract-fixture");
    expect(
      Object.keys(body.questions).filter((k) => k.startsWith("supports_")),
    ).toHaveLength(faqs.length);
    expect(body.questions.faq_0.criteria.true).toContain("applicable");
  });
  it("rejects missing answers, out-of-range values and unexpected options", () => {
    const missing = jevFixture();
    delete missing.answers.ongoing_outage;
    expect(() => parseJev(missing)).toThrow();
    const invalid = jevFixture();
    invalid.answers.ongoing_outage = { type: "noul", noul: 2 };
    expect(() => parseJev(invalid)).toThrow();
    const outside = jevFixture();
    outside.answers.urgency = {
      type: "choice",
      choice: "refund_now",
      confidence: 1,
      probabilities: { refund_now: 1 },
    };
    expect(() => parseJev(outside)).toThrow();
  });
  it("does not fall back silently or retry a rejected provider call", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("unavailable", {
          status: 429,
          headers: { "Retry-After": "7" },
        }),
    );
    const models = createModels(
      readConfig({
        DECISION_PROVIDER: "jev",
        REPLY_PROVIDER: "openai",
        OPENAI_API_KEY: "test",
        TYPESAFE_API_KEY: "test",
      }),
      fetcher,
    );
    await expect(models.assess(state)).rejects.toMatchObject({
      status: 503,
      details: { retry_after_seconds: 7 },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("provides a backoff hint for overload when the provider sends no Retry-After", async () => {
    const models = createModels(
      readConfig({
        DECISION_PROVIDER: "jev",
        REPLY_PROVIDER: "openai",
        OPENAI_API_KEY: "test",
        TYPESAFE_API_KEY: "test",
      }),
      async () => new Response("overloaded", { status: 529 }),
    );
    await expect(models.assess(state)).rejects.toMatchObject({
      details: { retry_after_seconds: 2 },
    });
  });
  it("does not block an incident because descriptive fields are uncertain", () => {
    const raw = jevFixture();
    raw.answers.urgency = {
      type: "choice",
      choice: "critical",
      confidence: 0.95,
      probabilities: { critical: 0.99, high: 0.01, medium: 0, low: 0 },
    };
    for (const field of [
      "sentiment",
      "language",
      "product_area",
      "issue_type",
    ]) {
      const current = raw.answers[field] as { confidence: number };
      current.confidence = 0.1;
    }
    for (const field of [
      "ongoing_outage",
      "multiple_users",
      "core_work_blocked",
    ])
      raw.answers[field] = { type: "noul", noul: 0.95 };
    const result = parseJev(raw);
    expect(result.assessment.classification_confidence).toBe(0.95);
    expect(decide(result.assessment).incident_allowed).toBe(true);
  });
  it("a low-confidence urgency judgment still blocks incident automation", () => {
    const raw = jevFixture();
    (raw.answers.urgency as { confidence: number }).confidence = 0.2;
    for (const field of [
      "ongoing_outage",
      "multiple_users",
      "core_work_blocked",
    ])
      raw.answers[field] = { type: "noul", noul: 0.95 };
    expect(decide(parseJev(raw).assessment).incident_allowed).toBe(false);
  });
  it("does not confuse a high relevance probability with complete answer coverage", () => {
    const raw = jevFixture();
    for (let i = 0; i < faqs.length; i++)
      raw.answers[`supports_${i}`] = { type: "noul", noul: 0.05 };
    const result = parseJev(raw);
    expect(result.assessment.faq_scores.some((f) => f.relevance > 0.9)).toBe(
      true,
    );
    expect(decide(result.assessment).action).toBe("escalate_to_human");
  });
  it("ignores sufficiency from a document that will not be sent to GPT", () => {
    const raw = jevFixture();
    for (let i = 0; i < faqs.length; i++) {
      raw.answers[`faq_${i}`] = { type: "noul", noul: i < 3 ? 0.99 : 0.8 };
      raw.answers[`supports_${i}`] = {
        type: "noul",
        noul: i === 5 ? 0.99 : 0.05,
      };
    }
    const result = parseJev(raw);
    expect(result.assessment.knowledge_sufficient).toBe(0.05);
    expect(decide(result.assessment).action).toBe("escalate_to_human");
  });
  it("accepts Noul uncertainty without interpreting it as medium relevance intensity", () => {
    const raw = jevFixture();
    raw.answers.faq_0 = { type: "noul", noul: 0.5 };
    const result = parseJev(raw);
    expect(result.assessment.faq_scores[0].relevance).toBe(0.5);
    expect(decide(result.assessment).knowledge_ids).not.toContain(faqs[0].id);
  });
  it("rejects a Choice inconsistent with its distribution and missing usage", () => {
    const raw = jevFixture();
    raw.answers.urgency = {
      type: "choice",
      choice: "low",
      confidence: 0.9,
      probabilities: { low: 0.1, medium: 0.8, high: 0.1, critical: 0 },
    };
    expect(() => parseJev(raw)).toThrow("highest-probability");
    const { usage, ...withoutUsage } = jevFixture();
    expect(() => parseJev(withoutUsage)).toThrow();
  });
});

function openaiResponse(value: unknown, status = "completed") {
  if (
    value &&
    typeof value === "object" &&
    "faq_scores" in value &&
    Array.isArray(value.faq_scores)
  ) {
    value = {
      ...value,
      faq_scores: Object.fromEntries(
        value.faq_scores.map((f: { id: string; relevance: number }) => [
          f.id,
          f.relevance,
        ]),
      ),
    };
  }
  return Response.json({
    id: "resp_fixture",
    object: "response",
    created_at: 1,
    status,
    model: "gpt-contract-fixture",
    output: [
      {
        type: "message",
        id: "msg_fixture",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: JSON.stringify(value), annotations: [] },
        ],
      },
    ],
    usage: { input_tokens: 20, output_tokens: 20, total_tokens: 40 },
  });
}
describe("OpenAI SDK contract (simulated HTTP)", () => {
  it("uses strict structured output for decisions and validates every FAQ ID", async () => {
    let body: Record<string, unknown> = {};
    const fetcher: typeof fetch = async (_url, init) => {
      body = JSON.parse(init?.body as string);
      return openaiResponse(mockAssessment(state));
    };
    const models = createModels(
      readConfig({ OPENAI_API_KEY: "test" }),
      fetcher,
    );
    const result = await models.assess(state);
    expect(result.assessment.product_area).toBe("appearance");
    expect(body.store).toBe(false);
    expect(body.text).toMatchObject({
      format: { type: "json_schema", strict: true },
    });
  });
  it("reply gets only selected FAQ and no execution tools", async () => {
    let body: Record<string, unknown> = {};
    const fetcher: typeof fetch = async (_url, init) => {
      body = JSON.parse(init?.body as string);
      return openaiResponse({
        reply: "Use Settings > Appearance.",
        citation_ids: ["appearance"],
      });
    };
    const models = createModels(
      readConfig({ OPENAI_API_KEY: "test" }),
      fetcher,
    );
    const decision = decide(mockAssessment(state));
    const result = await models.reply({ state, decision, incident: null });
    expect(result.citation_ids).toEqual(["appearance"]);
    expect(body.tools).toBeUndefined();
    expect(JSON.parse(body.input as string).faq.length).toBe(
      decision.knowledge_ids.length,
    );
  });
  it("rejects invented references and incomplete replies", async () => {
    const models = createModels(
      readConfig({ OPENAI_API_KEY: "test" }),
      async () =>
        openaiResponse({ reply: "See this", citation_ids: ["invented"] }),
    );
    const input = {
      state,
      decision: decide(mockAssessment(state)),
      incident: null,
    };
    await expect(models.reply(input)).rejects.toThrow("unsupported citation");
    const incomplete = createModels(
      readConfig({ OPENAI_API_KEY: "test" }),
      async () => openaiResponse({}, "incomplete"),
    );
    await expect(incomplete.reply(input)).rejects.toThrow();
  });
});
