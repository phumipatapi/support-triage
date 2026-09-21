import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import faqs from "../data/faq.json";
import {
  Assessment,
  type AssessmentData,
  type DecisionData,
  type State,
} from "./schemas";
import { TRIAGE_SYSTEM, REPLY_SYSTEM, PROMPT_VERSION } from "./prompts";
import type { AppConfig } from "./config";
import { AppError } from "./errors";

export { faqs };
export type ModelResult = {
  assessment: AssessmentData;
  metadata: Record<string, unknown>;
};
export type ReplyInput = {
  state: State;
  decision: DecisionData;
  incident: unknown;
};
export type ReplyResult = {
  reply: string;
  citation_ids: string[];
  metadata: Record<string, unknown>;
};
export interface Models {
  name: string;
  assess(state: State): Promise<ModelResult>;
  reply(input: ReplyInput): Promise<ReplyResult>;
}
type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string };
const choices = (instructions: string, values: string[]): Question => ({
  type: "choice",
  instructions: `${TRIAGE_SYSTEM}\n${instructions}`,
  criteria: Object.fromEntries(values.map((v) => [v, v])),
});
const noul = (instructions: string): Question => ({
  type: "noul",
  instructions: `${TRIAGE_SYSTEM}\n${instructions}`,
});

// IDs are not instructions: every question names the state field and its exact judgment.
export function buildQuestions(): Record<string, Question> {
  return {
    urgency: choices(
      "What is the urgency of the current unresolved issues in `conversation`?",
      ["critical", "high", "medium", "low"],
    ),
    product_area: choices(
      "Which product area is the main unresolved issue in `conversation` about?",
      ["billing", "availability", "appearance", "account", "other", "unknown"],
    ),
    issue_type: choices(
      "What is the primary unresolved issue type in `conversation`?",
      [
        "billing",
        "outage",
        "bug",
        "how_to",
        "feature_request",
        "other",
        "unknown",
      ],
    ),
    sentiment: choices(
      "What is the customer's current sentiment in `conversation.messages`?",
      ["angry", "frustrated", "neutral", "positive", "unknown"],
    ),
    language: choices(
      "What language does the customer use most recently in `conversation.messages`? th=Thai, en=English.",
      ["th", "en", "other", "unknown"],
    ),
    ongoing_outage: noul(
      "Does `conversation` report an outage that remains unresolved? A green status page alone is not resolution.",
    ),
    multiple_users: noul(
      "Does `conversation` report multiple users actually affected? Seat count alone is insufficient.",
    ),
    core_work_blocked: noul(
      "Does `conversation` report currently blocked core work, rather than a cosmetic inconvenience?",
    ),
    deadline: noul(
      "Does `conversation` report a concrete near-term business deadline?",
    ),
    financial_risk: noul(
      "Does `conversation` contain unresolved disputed, duplicate, missing-payment or paid-entitlement issues?",
    ),
    unresolved_bug: noul(
      "Does `conversation` contain a reproducible bug that has not been resolved? A new question does not resolve it.",
    ),
    feature_request: noul(
      "Does `conversation` contain a request for an additional feature?",
    ),
    knowledge_sufficient: noul(
      "Can `faq` safely resolve ALL current issues in `conversation` with information alone, without account-specific verification or human investigation?",
    ),
    ...Object.fromEntries(
      faqs.map((faq, index) => [
        `faq_${index}`,
        noul(
          `Does the content of \`faq[${index}]\` (ID ${faq.id}) provide useful support guidance for the current unresolved issues in \`conversation\`? Mere shared words are insufficient.`,
        ),
      ]),
    ),
  };
}

const probability = z.number().min(0).max(1);
const ChoiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: probability,
  probabilities: z.record(z.string(), probability),
});
const NoulAnswer = z.object({ type: z.literal("noul"), noul: probability });
const JevResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.union([ChoiceAnswer, NoulAnswer])),
  usage: z.unknown().optional(),
});

export function parseJev(raw: unknown): ModelResult {
  const response = JevResponse.parse(raw);
  const questions = buildQuestions();
  const result: Record<string, unknown> = {};
  const confidences: number[] = [];
  for (const [id, q] of Object.entries(questions)) {
    const answer = response.answers[id];
    if (!answer || answer.type !== q.type)
      throw new Error(`Missing or mismatched Jev answer: ${id}`);
    if (answer.type === "choice" && q.type === "choice") {
      if (!(answer.choice in q.criteria))
        throw new Error("Jev choice is outside the requested schema");
      const keys = Object.keys(answer.probabilities);
      if (
        keys.length !== Object.keys(q.criteria).length ||
        keys.some((k) => !(k in q.criteria)) ||
        Math.abs(
          Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1,
        ) > 0.02
      )
        throw new Error("Invalid Jev probability distribution");
      result[id] = answer.choice;
      confidences.push(answer.confidence);
    } else if (answer.type === "noul") result[id] = answer.noul;
  }
  const assessment = Assessment.parse({
    ...result,
    classification_confidence: Math.min(...confidences),
    faq_scores: faqs.map((faq, i) => ({
      id: faq.id,
      relevance: result[`faq_${i}`],
    })),
  });
  return {
    assessment,
    metadata: {
      provider: "jev",
      model: response.model,
      usage: response.usage,
      answers: response.answers,
      prompt_version: PROMPT_VERSION,
    },
  };
}

export function validateAssessment(value: unknown): AssessmentData {
  const a = Assessment.parse(value);
  const ids = a.faq_scores.map((f) => f.id);
  if (
    ids.length !== faqs.length ||
    new Set(ids).size !== faqs.length ||
    ids.some((id) => !faqs.some((f) => f.id === id))
  )
    throw new Error("Assessment must score each known FAQ exactly once");
  return a;
}
const Reply = z.object({
  reply: z.string(),
  citation_ids: z.array(z.string()),
});

export function createModels(
  config: AppConfig,
  fetcher: typeof fetch = fetch,
): Models {
  const openai = () =>
    new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      timeout: 20_000,
      maxRetries: 0,
      fetch: fetcher,
    });
  return {
    name: config.DECISION_PROVIDER,
    async assess(state) {
      const started = performance.now();
      const input = { conversation: state, faq: faqs };
      if (config.DECISION_PROVIDER === "mock")
        return {
          assessment: mockAssessment(state),
          metadata: {
            provider: "mock",
            model: "offline-keyword-stub",
            prompt_version: PROMPT_VERSION,
            latency_ms: 0,
          },
        };
      if (config.DECISION_PROVIDER === "jev") {
        const response = await fetcher("https://api.typesafe.ai/v1/systemone", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.TYPESAFE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: config.JEV_MODEL,
            state: input,
            questions: buildQuestions(),
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok)
          throw new AppError(
            503,
            "provider_unavailable",
            `Decision provider returned HTTP ${response.status}.`,
          );
        const result = parseJev(await response.json());
        result.metadata.latency_ms = Math.round(performance.now() - started);
        return result;
      }
      const response = await openai().responses.parse({
        model: config.OPENAI_MODEL,
        store: false,
        instructions:
          TRIAGE_SYSTEM +
          " Score every supplied FAQ exactly once. classification_confidence is a self-estimate, not calibrated probability.",
        input: JSON.stringify(input),
        text: { format: zodTextFormat(Assessment, "triage_assessment") },
        max_output_tokens: 1800,
      });
      if (response.status !== "completed" || !response.output_parsed)
        throw new Error("Incomplete or refused assessment");
      return {
        assessment: validateAssessment(response.output_parsed),
        metadata: {
          provider: "openai",
          model: response.model,
          usage: response.usage,
          response_id: response.id,
          prompt_version: PROMPT_VERSION,
          latency_ms: Math.round(performance.now() - started),
          confidence_kind: "uncalibrated_self_estimate",
        },
      };
    },
    async reply(input) {
      if (config.REPLY_PROVIDER === "mock") return mockReply(input);
      const started = performance.now();
      const selected = faqs.filter((f) =>
        input.decision.knowledge_ids.includes(f.id),
      );
      const response = await openai().responses.parse({
        model: config.OPENAI_MODEL,
        store: false,
        instructions: REPLY_SYSTEM,
        input: JSON.stringify({ ...input, faq: selected }),
        text: { format: zodTextFormat(Reply, "support_reply") },
        max_output_tokens: 900,
      });
      if (response.status !== "completed" || !response.output_parsed)
        throw new Error("Incomplete or refused reply");
      const reply = response.output_parsed;
      if (
        !reply.reply.trim() ||
        reply.reply.length > 6000 ||
        reply.citation_ids.some(
          (id) => !input.decision.knowledge_ids.includes(id),
        )
      )
        throw new Error("Invalid reply or unsupported citation");
      return {
        ...reply,
        metadata: {
          provider: "openai",
          model: response.model,
          usage: response.usage,
          response_id: response.id,
          prompt_version: PROMPT_VERSION,
          latency_ms: Math.round(performance.now() - started),
        },
      };
    },
  };
}

// Deliberately simple and explicitly labelled. This exercises plumbing, not AI quality.
export function mockAssessment(state: State): AssessmentData {
  const text = state.messages
    .filter((m) => m.role !== "assistant")
    .map((m) => m.content)
    .join("\n")
    .toLowerCase();
  const last =
    state.messages
      .filter((m) => m.role !== "assistant")
      .at(-1)
      ?.content.toLowerCase() ?? "";
  const resolved = /resolved|working again|กลับมาใช้ได้|แก้ได้แล้ว/.test(last);
  const outage =
    !resolved && /error 500|outage|เข้าไม่ได้|service down/.test(text);
  const multiple =
    /coworker|everyone|multiple users|เพื่อนร่วมงาน|ทั้งทีม|หลายคน/.test(text);
  const billing =
    !resolved && /charge|payment|refund|charged|เงิน|ชำระ/.test(text);
  const bug =
    !resolved && /bug|still.*light|ไม่เปลี่ยน|doesn.t work/.test(text);
  const theme = /dark|theme|ธีม|มืด/.test(text);
  const exportHelp = /export|ส่งออก/.test(text);
  const deadline = /in 2 hours|presentation|demo|บ่ายนี้|deadline/.test(text);
  const unknown =
    !outage && !billing && !bug && !theme && !exportHelp && !resolved;
  const area = billing
    ? "billing"
    : outage
      ? "availability"
      : theme
        ? "appearance"
        : unknown
          ? "unknown"
          : "other";
  return Assessment.parse({
    urgency:
      outage && multiple
        ? "critical"
        : outage || billing
          ? "high"
          : bug
            ? "medium"
            : "low",
    product_area: area,
    issue_type: billing
      ? "billing"
      : outage
        ? "outage"
        : bug
          ? "bug"
          : /schedule|feature|ตั้งเวลา/.test(text)
            ? "feature_request"
            : unknown
              ? "unknown"
              : "how_to",
    sentiment: /ridiculous|HELLO|โวย/i.test(text)
      ? "angry"
      : bug
        ? "frustrated"
        : "neutral",
    language: /[ก-๙]/.test(last) ? "th" : "en",
    classification_confidence: unknown ? 0.3 : 0.95,
    ongoing_outage: outage ? 0.95 : 0.05,
    multiple_users: multiple ? 0.95 : 0.05,
    core_work_blocked: outage || (billing && deadline) ? 0.95 : 0.05,
    deadline: deadline ? 0.95 : 0.05,
    financial_risk: billing ? 0.95 : 0.05,
    unresolved_bug: bug ? 0.95 : 0.05,
    feature_request: /schedule|feature|ตั้งเวลา/.test(text) ? 0.95 : 0.05,
    knowledge_sufficient: !outage && !billing && !bug && !unknown ? 0.95 : 0.05,
    faq_scores: faqs.map((f) => ({
      id: f.id,
      relevance:
        (f.id.startsWith("billing") && billing) ||
        (f.id === "availability" && outage) ||
        (["appearance", "theme-schedule"].includes(f.id) && theme) ||
        (f.id === "export" && exportHelp)
          ? 0.95
          : 0.05,
    })),
  });
}
export function mockReply({ decision, incident }: ReplyInput): ReplyResult {
  const thai = decision.extracted.language === "th";
  const text =
    decision.action === "auto_respond"
      ? (thai ? "ข้อมูลอ้างอิงที่เกี่ยวข้อง: " : "Relevant reference: ") +
        faqs
          .filter((f) => decision.knowledge_ids.includes(f.id))
          .map((f) => f.content)
          .join(" ")
      : thai
        ? "แนะนำให้เจ้าหน้าที่ส่งเคสนี้ให้ทีมที่เกี่ยวข้องตรวจสอบ ยังไม่ยืนยันสาเหตุหรือเวลาที่แก้ไขเสร็จ"
        : "I recommend human review of the unresolved issue. Payment status, root cause and resolution time have not been verified.";
  return {
    reply: `[OFFLINE MOCK] ${text}${incident ? ` ${thai ? "ผล incident จำลอง" : "Simulated incident result"}: ${JSON.stringify(incident)}` : ""}`,
    citation_ids: decision.knowledge_ids,
    metadata: {
      provider: "mock",
      model: "template",
      prompt_version: PROMPT_VERSION,
    },
  };
}
