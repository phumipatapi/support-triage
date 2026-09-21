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
      async () => new Response("unavailable", { status: 429 }),
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
    await expect(models.assess(state)).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

function openaiResponse(value: unknown, status = "completed") {
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
