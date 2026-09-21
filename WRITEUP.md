# Engineering write-up

## Architecture and alternatives

One Node.js process runs Next.js Route Handlers with TypeScript, Zod and direct SQLite queries. The framework is familiar to the developer; a separate server framework or ORM adds little to three endpoints. Transport, orchestration, model adapters, policy, tools and persistence have explicit boundaries. No frontend, embeddings, vector service, auth or infrastructure is included.

Jev receives the ordered thread, metadata and six short fictional FAQ documents. One call asks independent classification/impact questions and a relevance question for each FAQ. Code combines these judgments; GPT only composes the reply. The FAQ operation is a read-only tool, fused with assessment to avoid a redundant network round trip. It is workflow-driven tool invocation, not an unrestricted model tool loop. An OpenAI-only adapter preserves the assignment's single-key reviewer path. The offline mock is explicitly a weak plumbing baseline.

The code permits information retrieval and low-risk supported replies. A strongly supported ongoing multi-user outage can create one **simulated** incident per conversation. Financial issues route to billing; bugs route to engineering; uncertain or high-impact cases escalate. Routing is a recommendation, not a notification. No refund, entitlement, payment or paging tool exists. High confidence never grants financial authority. GPT sees actual outcomes and selected references but has no execution tools.

## Reliability and trade-offs

Input and run creation are atomic. A database constraint serializes each conversation. API idempotency binds a scoped key to a normalized payload and replays the saved response. Assessment and policy decision are checkpointed before effects. Caller and simulated remote provider use separate databases: the provider commits independently and deduplicates by stable operation key. A lost acknowledgement becomes `unknown`, never assumed failure. Replaying that key reconciles the existing incident. This relies on the provider contract; a non-idempotent real provider would require a different integration.

Calls have 20-second timeouts without hidden retries; a 120-second run lease bounds crash recovery. Failed runs require the original key/body, and block new turns until resumed. No background queue, automatic cancellation, incident reopening, multi-replica deployment or context compaction is implemented. One incident per conversation is deliberately conservative; a new unrelated outage belongs in a new conversation. Stored reply plus completion are transactional. Detailed audit stays in SQLite; logs reference it rather than duplicating sensitive text.

With another week: add cancellation/recovery controls, incident lifecycle and cross-ticket correlation, privacy retention/redaction, larger held-out evaluation and measured threshold tuning. Batch-scoring the entire FAQ works only for a small corpus; add a retrieval shortlist when measured size/cost warrants it. No latency or savings claim is made without live measurement. Prompt instructions reduce unsupported reply claims but cannot guarantee their absence.

## Specific failure modes

**Billing:** three reported charges may be pending authorizations, not three settled payments. The deadline and missing paid access warrant high urgency regardless of Free plan. Policy forbids financial execution; billing must verify records. A payment FAQ can inform the reply but cannot resolve the transaction. A customer claiming to be an approving manager does not create authority.

**Thai outage:** several machines and coworkers failing provide stronger incident evidence than a green status page. The thread retains region and 45-seat metadata, but seat count alone does not establish actual affected users. Classification or Thai comprehension can still be wrong; the model's confidence is a signal, not proof. Simulated incident creation remains deduplicated through timeout/restart. The reply must not promise root cause or repair time.

**Theme:** the last scheduling question does not close the earlier System Default bug. Route the bug to engineering and address the feature question using supplied docs. The fictional FAQ has no separate Dark toggle: inventing one would be an incorrect answer. A later explicit resolution can change the next decision without erasing prior audit history.

## Evaluation and production monitoring

Deterministic tests cover policy, provider schema boundaries, HTTP errors, concurrent duplicates, replay conflicts, persistent history, remote-commit timeout and reply failure after an effect. A real-process HTTP smoke test restarts Next.js. Offline labelled eval runs the complete workflow with a mock and marks results accordingly; live mode uses the same cases and records model versions, token usage and latency. Live quality is unverified until keys are supplied.

Before production, measure critical-outage recall, false escalations, billing safety violations, FAQ retrieval recall, grounded reply accuracy, Thai-language performance, operator overrides, p50/p95 latency and cost per resolved ticket. Review a stratified sample with humans and run a held-out set on prompt/model changes. Version prompts and policy, pin provider models when possible, and investigate drift by language/issue type rather than relying on aggregate accuracy. Jev probability-derived confidence and GPT self-estimated confidence are different signals; neither threshold has been calibrated on this tiny dataset.
