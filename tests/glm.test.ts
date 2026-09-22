import { describe, it, expect, vi } from "vitest";
import { readConfig } from "../lib/config";
import { createModels, mockAssessment } from "../lib/models";
import { decide } from "../lib/policy";
import type { State } from "../lib/schemas";

const state: State = {
  customer: { plan: "pro", region: "Thailand" },
  messages: [
    {
      id: "one",
      role: "customer",
      content: "How do I enable dark mode?",
      timestamp: "2026-09-22T00:00:00Z",
    },
  ],
};
const input = {
  state,
  decision: decide(mockAssessment(state)),
  incident: null,
};
const config = () =>
  readConfig({
    DECISION_PROVIDER: "jev",
    TYPESAFE_API_KEY: "test-jev",
    REPLY_PROVIDER: "glm",
    GLM_API_KEY: "test-glm",
  });
function completion(
  content = JSON.stringify({
    reply: "Open Settings > Appearance.",
    citation_ids: ["appearance"],
  }),
  finish = "stop",
) {
  return {
    id: "glm_fixture",
    model: "glm-4.7",
    choices: [
      {
        finish_reason: finish,
        message: {
          role: "assistant",
          content,
          reasoning_content: "private reasoning must not be exposed",
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
  };
}
describe("GLM General API reply adapter", () => {
  it("supports Jev + GLM without an OpenAI key and validates required GLM credentials", () => {
    expect(config().OPENAI_API_KEY).toBeUndefined();
    expect(() =>
      readConfig({
        DECISION_PROVIDER: "jev",
        TYPESAFE_API_KEY: "test",
        REPLY_PROVIDER: "glm",
      }),
    ).toThrow("GLM_API_KEY");
    expect(() =>
      readConfig({
        DECISION_PROVIDER: "openai",
        REPLY_PROVIDER: "glm",
        GLM_API_KEY: "test",
      }),
    ).toThrow("OPENAI_API_KEY");
  });
  it("uses only Z.AI General API with GLM key, JSON mode and no execution tools", async () => {
    const fetcher = vi.fn(async () => Response.json(completion()));
    const reply = await createModels(config(), fetcher).reply(input);
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe("https://api.z.ai/api/paas/v4/chat/completions");
    expect(calls[0][1].headers).toMatchObject({
      Authorization: "Bearer test-glm",
    });
    const body = JSON.parse(calls[0][1].body as string);
    expect(body).toMatchObject({
      model: "glm-4.7",
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
    });
    expect(body.tools).toBeUndefined();
    expect(JSON.parse(body.messages[1].content).execution_facts).toMatchObject({team_contacted:false,payment_records_verified:false,refund_issued:false});
    expect(JSON.parse(body.messages[1].content).decision.reasons).toBeUndefined();
    expect(
      JSON.parse(body.messages[1].content)
        .faq.map((f: { id: string }) => f.id)
        .sort(),
    ).toEqual([...input.decision.knowledge_ids].sort());
    expect(reply.metadata).toMatchObject({ provider: "glm", model: "glm-4.7" });
    expect(JSON.stringify(reply)).not.toContain("private reasoning");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["not json", "stop"],
    [JSON.stringify({ reply: "OK", citation_ids: ["invented"] }), "stop"],
    [JSON.stringify({ reply: "OK", citation_ids: [] }), "length"],
    [JSON.stringify({ reply: " ", citation_ids: [] }), "stop"],
    [
      JSON.stringify({ reply: "OK", citation_ids: [], execute: "refund" }),
      "stop",
    ],
  ])(
    "rejects incomplete or unsupported output (%s, %s)",
    async (content, finish) => {
      await expect(
        createModels(config(), async () =>
          Response.json(completion(content, finish)),
        ).reply(input),
      ).rejects.toMatchObject({ status: 503, code: "invalid_glm_reply" });
    },
  );
  it("does not silently retry or switch provider on rate limits", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("sensitive provider body", {
          status: 429,
          headers: { "Retry-After": "5" },
        }),
    );
    await expect(
      createModels(config(), fetcher).reply(input),
    ).rejects.toMatchObject({
      code: "glm_unavailable",
      details: { retry_after_seconds: 5 },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("uses supported low thinking instead of disabling it for GLM-5.3", async () => {
    let body: Record<string, unknown> = {};
    await createModels(
      { ...config(), GLM_MODEL: "glm-5.3" },
      async (_url, init) => {
        body = JSON.parse(init?.body as string);
        return Response.json(completion());
      },
    ).reply(input);
    expect(body).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "low",
    });
  });
});
