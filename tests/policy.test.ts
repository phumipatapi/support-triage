import { describe, expect, it } from "vitest";
import { decide } from "../lib/policy";
import { mockAssessment } from "../lib/models";
import { Ticket, type AssessmentData } from "../lib/schemas";
import { readConfig } from "../lib/config";

const base = mockAssessment({
  customer: Ticket.parse({ customer: {}, messages: [{ content: "dark mode" }] })
    .customer,
  messages: [
    {
      id: "1",
      role: "customer",
      content: "How do I enable dark mode?",
      timestamp: new Date().toISOString(),
    },
  ],
});
const assessment = (override: Partial<AssessmentData>) => ({
  ...base,
  ...override,
});
describe("autonomy policy", () => {
  it("does not auto-respond based only on FAQ relevance", () => {
    expect(decide(assessment({ knowledge_sufficient: 0.3 })).action).toBe(
      "escalate_to_human",
    );
    expect(decide(assessment({ classification_confidence: 0.3 })).action).toBe(
      "escalate_to_human",
    );
    expect(
      decide(
        assessment({
          faq_scores: base.faq_scores.map((f) => ({ ...f, relevance: 0.1 })),
        }),
      ).action,
    ).toBe("escalate_to_human");
  });
  it("routes financial risk even when the model suggests a low urgency informational answer", () => {
    const d = decide(
      assessment({
        urgency: "low",
        financial_risk: 0.9,
        knowledge_sufficient: 0.99,
      }),
    );
    expect(d).toMatchObject({
      urgency: "high",
      action: "route_to_specialist",
      specialist: "billing",
      incident_allowed: false,
    });
  });
  it("requires ongoing outage, multiple affected people, blocked work and confidence for an incident", () => {
    const full = assessment({
      ongoing_outage: 0.95,
      multiple_users: 0.95,
      core_work_blocked: 0.95,
    });
    expect(decide(full).incident_allowed).toBe(true);
    for (const field of [
      "ongoing_outage",
      "multiple_users",
      "core_work_blocked",
      "classification_confidence",
    ] as const)
      expect(decide({ ...full, [field]: 0.2 }).incident_allowed).toBe(false);
  });
  it("does not turn an unresolved bug into an automated FAQ answer", () => {
    expect(
      decide(assessment({ unresolved_bug: 0.9, feature_request: 0.9 })),
    ).toMatchObject({
      urgency: "medium",
      action: "route_to_specialist",
      specialist: "engineering",
    });
  });
  it("retains serious urgency when classifications are uncertain", () => {
    expect(
      decide(
        assessment({ urgency: "critical", classification_confidence: 0.1 }),
      ),
    ).toMatchObject({
      urgency: "critical",
      action: "escalate_to_human",
      incident_allowed: false,
    });
  });
  it("does not let a misleading FAQ sufficiency judgment override outage evidence", () => {
    const d = decide(
      assessment({
        urgency: "low",
        knowledge_sufficient: 1,
        ongoing_outage: 0.95,
        multiple_users: 0.95,
        core_work_blocked: 0.95,
      }),
    );
    expect(d).toMatchObject({
      urgency: "critical",
      action: "escalate_to_human",
      incident_allowed: true,
    });
  });
  it("rejects missing live credentials and accidental live/mock combinations", () => {
    expect(() =>
      readConfig({ DECISION_PROVIDER: "jev", REPLY_PROVIDER: "openai" }),
    ).toThrow("OPENAI_API_KEY");
    expect(() =>
      readConfig({
        DECISION_PROVIDER: "jev",
        REPLY_PROVIDER: "openai",
        OPENAI_API_KEY: "test",
      }),
    ).toThrow("TYPESAFE_API_KEY");
    expect(() =>
      readConfig({
        DECISION_PROVIDER: "openai",
        REPLY_PROVIDER: "mock",
        OPENAI_API_KEY: "test",
      }),
    ).toThrow("Live decisions");
  });
});
