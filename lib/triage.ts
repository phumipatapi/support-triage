import { randomUUID } from "node:crypto";
import { Store } from "./db";
import { AppError } from "./errors";
import {
  InputMessage,
  Ticket,
  Assessment,
  Decision,
  type IncidentOutput,
  type AssessmentData,
  type DecisionData,
} from "./schemas";
import { decide } from "./policy";
import { faqs, validateAssessment, type Models } from "./models";
import {
  executeIncident,
  toolDefinitions,
  type IncidentProvider,
} from "./tools";
import { z } from "zod";

const Key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
export class TriageService {
  constructor(
    public store: Store,
    private models: Models,
    private incidents: IncidentProvider,
  ) {}
  async submit(raw: unknown, key: string | null, conversationId?: string) {
    if (!key)
      throw new AppError(
        400,
        "missing_idempotency_key",
        "Supply an Idempotency-Key header for every POST.",
      );
    Key.parse(key);
    if (conversationId) z.string().uuid().parse(conversationId);
    const payload = conversationId
      ? InputMessage.parse(raw)
      : Ticket.parse(raw);
    const { run, replay } = this.store.begin(
      conversationId ? `message:${conversationId}` : "ticket",
      key,
      payload,
      conversationId,
    );
    if (replay)
      return {
        body: JSON.parse(run.response!),
        status: conversationId ? 200 : 201,
        replay: true,
      };
    try {
      const state = this.store.state(run.conversation_id);
      let assessment: AssessmentData;
      let decision: DecisionData;
      if (run.assessment && run.decision) {
        assessment = Assessment.parse(JSON.parse(run.assessment));
        decision = Decision.parse(JSON.parse(run.decision));
        this.store.audit(run.id, "checkpoint.resumed", {
          policy_version: decision.policy_version,
        });
      } else {
        toolDefinitions.search_knowledge_base.parameters.parse({
          conversation_id: run.conversation_id,
        });
        this.store.audit(run.id, "tool.started", {
          tool: "search_knowledge_base",
          arguments: { conversation_id: run.conversation_id },
          provider: this.models.name,
        });
        this.store.audit(run.id, "model.input", {
          conversation: state,
          faq: faqs,
        });
        const result = await this.models.assess(state);
        this.store.assertOwner(run);
        assessment = validateAssessment(result.assessment);
        decision = decide(assessment);
        this.store.audit(run.id, "model.assessed", {
          assessment,
          metadata: result.metadata,
        });
        this.store.audit(run.id, "tool.succeeded", {
          tool: "search_knowledge_base",
          scores: assessment.faq_scores,
          documents: faqs.filter((f) => decision.knowledge_ids.includes(f.id)),
        });
        this.store.checkpoint(run, assessment, decision);
      }
      let incident: IncidentOutput | null = null;
      if (decision.incident_allowed) {
        incident = await executeIncident(
          this.store,
          this.incidents,
          run,
          decision,
        );
        if (!decision.tools_called.includes("open_incident"))
          decision.tools_called.push("open_incident");
        this.store.checkpoint(run, assessment, decision);
      }
      this.store.assertOwner(run);
      const reply = await this.models.reply({ state, decision, incident });
      this.store.assertOwner(run);
      this.store.audit(run.id, "model.replied", { ...reply });
      const body = {
        conversation_id: run.conversation_id,
        run_id: run.id,
        reply: reply.reply,
        citation_ids: reply.citation_ids,
        decision,
        incident,
        mode: this.models.name,
        reply_provider: reply.metadata.provider,
      };
      this.store.complete(run, decision, body, reply.reply);
      return { body, status: conversationId ? 200 : 201, replay: false };
    } catch (error) {
      const code = error instanceof AppError ? error.code : "processing_failed";
      this.store.fail(run, code);
      throw new AppError(
        error instanceof AppError ? error.status : 503,
        code,
        error instanceof AppError
          ? error.message
          : "Processing failed. Retry the same payload and Idempotency-Key; completed side effects will be reused.",
        {
          conversation_id: run.conversation_id,
          run_id: run.id,
          retryable: true,
        },
      );
    }
  }
}

export function makeRequestId() {
  return randomUUID();
}
