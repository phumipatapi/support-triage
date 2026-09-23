import { describe, expect, it } from "vitest";
import {
  replyContext,
  replyLanguage,
  validateReply,
  finalizeReply,
} from "../lib/reply-context";
import { createModels, mockAssessment, type ReplyInput } from "../lib/models";
import { decide } from "../lib/policy";
import { readConfig } from "../lib/config";
import type { State, StoredMessage } from "../lib/schemas";

const message = (
  role: StoredMessage["role"],
  content: string,
): StoredMessage => ({
  id: crypto.randomUUID(),
  role,
  content,
  timestamp: new Date().toISOString(),
});
function input(...messages: StoredMessage[]): ReplyInput {
  const state: State = {
    customer: { plan: "pro", region: "Thailand" },
    messages,
  };
  return { state, decision: decide(mockAssessment(state)), incident: null };
}
const regression = () =>
  input(
    message(
      "customer",
      "My Mac is in dark mode, but the app stays light even after selecting System Default.",
    ),
    message("assistant", "เรากำลังส่งเรื่องให้วิศวกรแล้ว"),
    message("customer", "Also, can I schedule dark mode to turn on at 6pm?"),
  );

describe("reply evidence and language boundaries", () => {
  it("does not let Thai assistant history or customer region set English reply language", () => {
    const context = replyContext(regression());
    expect(context.response_language).toBe("en");
    expect(context.state.messages.every((m) => m.role === "customer")).toBe(
      true,
    );
    expect(context.execution_facts.team_contacted).toBe(false);
  });
  it("answers a Thai operator in Thai without replacing customer metadata", () => {
    const request = regression();
    request.state.messages[0].content += " This is ridiculous!";
    request.state.messages.push(
      message("operator", "ช่วยสรุปสิ่งที่ยังต้องตรวจสอบครับ"),
    );
    expect(replyLanguage(request)).toBe("th");
    expect(mockAssessment(request.state).language).toBe("en");
    expect(mockAssessment(request.state).sentiment).toBe("angry");
    request.state.messages.push(
      message("customer", "What app version do you need?"),
    );
    expect(replyLanguage(request)).toBe("en");
  });
  it.each([
    "เรากำลังนำเรื่องนี้ไปตรวจสอบกับวิศวกร",
    "We'll route this unresolved bug to engineering.",
    "We are investigating your issue.",
  ])("rejects the observed unsafe draft: %s", (text) => {
    expect(() => validateReply(text, regression())).toThrow();
  });
  it("allows recommendations and honest denials", () => {
    expect(() =>
      validateReply(
        "I recommend contacting engineering. We have not notified them. OS scheduling may help only after System Default is fixed.",
        regression(),
      ),
    ).not.toThrow();
  });
  it("blocks advice to postpone bank disputes without blocking verification advice", () => {
    for (const text of [
      "Avoid disputing charges prematurely until billing confirms these transactions.",
      "Do not initiate a chargeback until the review ends.",
      "Delay filing a dispute with your bank.",
    ]) {
      expect(() => validateReply(text, regression())).toThrowError(
        expect.objectContaining({ code: "unsupported_financial_advice" }),
      );
    }
    expect(() =>
      validateReply(
        "Billing must verify payment records before discussing refunds.",
        regression(),
      ),
    ).not.toThrow();
  });
  it("allows Thai technical names but rejects English-only response to Thai", () => {
    const request = input(
      message("customer", "System Default ไม่เปลี่ยนธีมครับ"),
    );
    expect(() =>
      validateReply("Please contact engineering.", request),
    ).toThrow();
    expect(() =>
      validateReply(
        "แนะนำให้เจ้าหน้าที่ตรวจสอบ System Default ยังไม่ได้แจ้งทีมครับ",
        request,
      ),
    ).not.toThrow();
    expect(() =>
      validateReply(
        "แนะนำให้ฝ่าย billing ตรวจสอบว่าได้คืนเงินแล้วหรือยัง โดยยังไม่มีข้อมูลยืนยันในระบบนี้",
        request,
      ),
    ).not.toThrow();
  });
  it("does not infer absent customer sentiment from operator politeness", () => {
    expect(
      mockAssessment(input(message("operator", "Thank you!")).state),
    ).toMatchObject({ sentiment: "unknown", language: "unknown" });
  });
  it("falls back to a factual Thai handoff with an existing incident, without claiming resolution", () => {
    const request = input(
      message("operator", "ระบบกลับมาแล้วครับ ช่วยสรุปเคสนี้"),
    );
    request.decision.action = "escalate_to_human";
    request.incident = { incident_id: "INC-test" };
    const checked = finalizeReply(
      { reply: "We have resolved the issue.", citation_ids: [] },
      request,
    );
    expect(checked.validation.reply_source).toBe("policy_fallback");
    expect(checked.reply).toContain("incident จำลอง");
    expect(checked.reply).not.toContain("แก้ไขแล้ว");
    expect(() => validateReply(checked.reply, request)).not.toThrow();
  });
});

describe.each(["openai", "glm"] as const)(
  "%s reply integration",
  (provider) => {
    const config = readConfig({
      DECISION_PROVIDER: "mock",
      REPLY_PROVIDER: provider,
      OPENAI_API_KEY: "test",
      GLM_API_KEY: "test",
    });
    function response(text: string) {
      const reply = { reply: text, citation_ids: [] };
      return provider === "glm"
        ? Response.json({
            id: "test",
            model: "fixture",
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: JSON.stringify(reply) },
              },
            ],
          })
        : Response.json({
            id: "test",
            object: "response",
            created_at: 1,
            status: "completed",
            model: "fixture",
            output: [
              {
                type: "message",
                id: "test",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify(reply),
                    annotations: [],
                  },
                ],
              },
            ],
          });
    }
    it("sends explicit language, human evidence and actual actions", async () => {
      let body: any;
      await createModels(config, async (_url, init) => {
        body = JSON.parse(init!.body as string);
        return response("I recommend contacting engineering.");
      }).reply(regression());
      const context = JSON.parse(
        provider === "openai" ? body.input : body.messages[1].content,
      );
      expect(context.response_language).toBe("en");
      expect(context.state.messages).toHaveLength(2);
      expect(context.execution_facts.team_contacted).toBe(false);
    });
    it("blocks a wrong-language draft before it can be persisted as success", async () => {
      const request = regression();
      request.decision.action = "auto_respond";
      await expect(
        createModels(config, async () =>
          response("แนะนำให้ติดต่อเจ้าหน้าที่ครับ"),
        ).reply(request),
      ).rejects.toMatchObject({ code: "reply_language_mismatch" });
    });
    it("replaces unsupported routing claims with an audited policy handoff", async () => {
      const result = await createModels(config, async () =>
        response("We'll route this to engineering."),
      ).reply(regression());
      expect(result.reply).toContain("recommend an engineering specialist");
      expect(result.reply).toContain("has not contacted any team");
      expect(result.citation_ids).toEqual([]);
      expect(result.metadata).toMatchObject({
        reply_source: "policy_fallback",
        rejected_draft_code: "unsupported_reply_claim",
      });
    });
    it("returns a safe billing handoff for a rejected financial draft without a second model call", async () => {
      const request = input(
        message("customer", "Payment failed and I was charged twice."),
      );
      let calls = 0;
      const result = await createModels(config, async () => {
        calls++;
        return response("Avoid disputing charges prematurely.");
      }).reply(request);
      expect(calls).toBe(1);
      expect(result.reply).toContain(
        "Payment and account records have not been verified",
      );
      expect(result.metadata).toMatchObject({
        reply_source: "policy_fallback",
        rejected_draft_code: "unsupported_financial_advice",
      });
    });
  },
);
