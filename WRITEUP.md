# Engineering write-up

## 1. Architecture and why

One Express/TypeScript process exposes ticket ingestion, conversational follow-up and audited history. Zod validates HTTP, model and tool boundaries; SQLite persists messages, decisions, attempts and responses. Direct SQL makes transactions and uniqueness constraints visible. A frontend framework, ORM and agent framework would add little to this bounded API slice.

OpenAI-only mode lets a reviewer use one injected key. Optional Jev assessment asks independent classification, impact and FAQ judgments in one request; GPT then writes the reply. The six fictional FAQ documents fit in context, so there is no embedding pipeline or vector database. Retrieval and assessment share a call behind the `search_knowledge_base` tool contract. This is explicit workflow orchestration, not model-selected unrestricted tool execution.

Code owns autonomy: supported low-risk information may auto-respond; financial issues recommend billing; unresolved bugs recommend engineering; uncertain or high-impact cases need human review. Strong evidence of an ongoing multi-user loss of core service permits one simulated incident per conversation. That tool makes a durable write in a separate provider database. No refund, payment, entitlement, notification or paging operation exists. Routing never means a team was contacted. The reply model has no execution tools.

## 2. Trade-offs under time

I prioritized replay safety over breadth. Input and run creation are atomic; a uniqueness constraint serializes each conversation. Request keys bind to normalized payloads. Assessment and policy are checkpointed before an effect. The incident provider independently stores a stable operation key and argument fingerprint. A timeout after its commit becomes an unknown outcome; replay reconciles the original incident. This depends on durable provider-side deduplication, not exactly-once network delivery.

Provider calls have bounded timeouts and no hidden retries. A lease bounds hard-crash recovery; failed runs require the original request before new turns. Completed replies replay across restarts. A rejected reply draft can use a marked, deterministic handoff only when policy already requires human review; this costs no extra model call. The terminal client replaces a UI. Authentication, deployment, queues, streaming, context compaction and incident lifecycle management were cut. SQLite assumes one local service; incidents cannot correlate tickets or reopen.

With another week: add recovery/cancellation controls, incident lifecycle and cross-ticket correlation, retention/redaction, a larger held-out evaluation set and measured threshold tuning. Scale retrieval only when corpus size justifies it. Prompting plus schema and language guards reduce some failures but do not establish factual correctness or calibrated confidence.

## 3. Specific failure modes

**Billing:** three bank-app entries do not establish three settled payments. Missing Pro access plus the presentation deadline warrant high urgency despite the Free plan. Billing must verify payment and entitlement records. A FAQ cannot confirm transactions, promise a refund or restore access. A ticket instruction to approve a refund has no execution authority. A narrow guard rejects common advice to postpone bank disputes; broader unsupported financial claims remain a live-evaluation risk.

**Thai outage:** failures across browsers and coworkers outweigh a green status-page report as evidence for investigation. Region and 45-seat metadata inform impact; seat count alone does not prove all seats are affected. Insufficient confidence conservatively escalates without automatic incident creation. A timeout after an incident commit is reconciled, not blindly repeated under a fresh key. The reply must not assert a root cause, repair time or that the customer's report is simulated; only the incident integration is simulated.

**Theme:** the final scheduling question does not resolve the earlier System Default bug. Preserve medium urgency and the engineering recommendation. The FAQ has no separate Dark toggle; OS scheduling depends on the broken synchronization working first. An English customer follow-up should receive English even after earlier assistant text used the wrong language. A Thai operator may request an internal Thai summary without changing the customer's extracted language or sentiment. Generated action claims remain a specific live-evaluation risk.

## 4. Evaluation in production

Deterministic tests cover policy, validation, provider parsing, concurrent requests, replay conflicts, persistent history and uncertain side effects. A real-process HTTP smoke test commits an incident, loses its acknowledgement, restarts and retries. The labelled offline harness verifies orchestration with a mock; live mode applies the same checks to actual providers. Results and limitations are recorded separately in `VALIDATION.md`; passing mock tests is not model-accuracy evidence.

Production measurements would include critical-outage recall, unnecessary escalations, prohibited financial/action claims, FAQ retrieval and answer support, conversation continuity, Thai/English consistency, operator overrides, p50/p95 latency and cost per resolved ticket. Human reviewers should assess a stratified sample, especially false negatives and unsupported replies. Run a held-out set before prompt/model changes, version prompts and policy, and retain provider versions, usage and tool outcomes for reconstruction. Track regressions by language and issue type rather than aggregate accuracy alone. Jev probabilities and GPT self-estimated confidence are different signals; neither is calibrated by this small authored set.
