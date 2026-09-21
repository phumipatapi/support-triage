import { z } from "zod";

export const Urgency = z.enum(["critical", "high", "medium", "low"]);
export const Area = z.enum([
  "billing",
  "availability",
  "appearance",
  "account",
  "other",
  "unknown",
]);
export const Issue = z.enum([
  "billing",
  "outage",
  "bug",
  "how_to",
  "feature_request",
  "other",
  "unknown",
]);
export const Sentiment = z.enum([
  "angry",
  "frustrated",
  "neutral",
  "positive",
  "unknown",
]);
export const Language = z.enum(["th", "en", "other", "unknown"]);
export const Action = z.enum([
  "auto_respond",
  "route_to_specialist",
  "escalate_to_human",
]);
const probability = z.number().min(0).max(1);
export const Customer = z
  .object({
    plan: z.enum(["free", "pro", "enterprise", "unknown"]).default("unknown"),
    region: z.string().trim().max(80).default("unknown"),
    seats: z.number().int().min(1).max(100000).optional(),
    tenure_months: z.number().int().min(0).max(1200).optional(),
    prior_tickets: z.number().int().min(0).optional(),
    daily_active: z.boolean().optional(),
  })
  .strict();
export const InputMessage = z
  .object({
    role: z.enum(["customer", "operator"]).default("customer"),
    content: z.string().trim().min(1).max(6000),
    timestamp: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export const Ticket = z
  .object({
    customer: Customer,
    messages: z.array(InputMessage).min(1).max(20),
  })
  .strict();
export type TicketInput = z.infer<typeof Ticket>;
export type MessageInput = z.infer<typeof InputMessage>;
export type StoredMessage = {
  id: string;
  role: "customer" | "operator" | "assistant";
  content: string;
  timestamp: string;
};
export type State = {
  customer: TicketInput["customer"];
  messages: StoredMessage[];
};

// All providers share one contract. These are judgments, not verified transaction facts.
export const Assessment = z.object({
  urgency: Urgency,
  product_area: Area,
  issue_type: Issue,
  sentiment: Sentiment,
  language: Language,
  classification_confidence: probability,
  ongoing_outage: probability,
  multiple_users: probability,
  core_work_blocked: probability,
  deadline: probability,
  financial_risk: probability,
  unresolved_bug: probability,
  feature_request: probability,
  knowledge_sufficient: probability,
  faq_scores: z.array(z.object({ id: z.string(), relevance: probability })),
});
export type AssessmentData = z.infer<typeof Assessment>;
export const Decision = z.object({
  urgency: Urgency,
  extracted: z.object({
    product_area: Area,
    issue_type: Issue,
    sentiment: Sentiment,
    language: Language,
  }),
  action: Action,
  specialist: z.enum(["billing", "engineering"]).nullable(),
  reasons: z.array(z.string()),
  knowledge_ids: z.array(z.string()),
  incident_allowed: z.boolean(),
  tools_called: z.array(z.string()),
  policy_version: z.string(),
});
export type DecisionData = z.infer<typeof Decision>;
export const IncidentArgs = z
  .object({
    conversation_id: z.string().uuid(),
    region: z.string().max(80),
    summary: z.string().min(1).max(200),
  })
  .strict();
export type IncidentInput = z.infer<typeof IncidentArgs>;
export const IncidentResult = z.object({
  incident_id: z.string().min(1),
  status: z.literal("open"),
  simulated: z.literal(true),
});
export type IncidentOutput = z.infer<typeof IncidentResult>;
