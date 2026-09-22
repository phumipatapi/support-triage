# Support Ticket Triage

A small API-only take-home: **Next.js + TypeScript + SQLite**. Jev evaluates the whole support thread and all six FAQ documents in **one request**; code applies the action policy; GPT writes the reply from the decision and observed tool outcomes. No vector database, embeddings, agent framework, or frontend.

**Status:** offline tests and a mock demo are provided. Live Jev/GPT quality and latency require your own keys and a live eval; mock results are not evidence of model quality. Incidents are explicitly simulated and stored in a separate SQLite database. No financial action, email, notification, or paging is performed.

## Run

Prerequisite: Node.js 22.13+ (Node 22 LTS recommended), npm. Run from this folder:

```sh
npm run setup
```

This installs the lockfile dependencies, copies `.env.example` to `.env.local` **only if absent**, and starts the server at http://127.0.0.1:3000. Defaults are offline mock/mock: no credentials, network model calls, or charges. SQLite tables are created lazily on the first ticket. The native SQLite package normally installs a prebuilt binary; unsupported platforms may need native build tools.

In another terminal:

```sh
npm run demo
```

The demo submits the Thai outage sample, repeats the same request, adds an operator message, and prints the audit URL. To try another sample: `npm run demo -- billing-thread` or `npm run demo -- theme-bug-thread`. `BASE_URL` can override the server URL.

### Jev + GPT

Edit `.env.local`, then restart the server:

```dotenv
DECISION_PROVIDER=jev
REPLY_PROVIDER=openai
TYPESAFE_API_KEY=your-key
OPENAI_API_KEY=your-key
JEV_MODEL=jev-latest
OPENAI_MODEL=gpt-4.1-mini
```

Jev needs TypeSafe API access. GPT model IDs are configurable; choose one your account supports with Responses structured outputs. Each provider call has a 20-second timeout and no automatic SDK retries. Errors are visible; there is no silent switch to another billable provider.

### Reviewer: OpenAI key only

```dotenv
DECISION_PROVIDER=openai
REPLY_PROVIDER=openai
OPENAI_API_KEY=your-key
```

This uses GPT for the same assessment contract and reply. No TypeSafe account is needed. Keys are server-only environment variables; `.env.local` and runtime data are ignored by Git. If no env file exists, provider defaults are OpenAI/OpenAI. The setup script deliberately selects mock mode for the first demo.

### Jev + GLM (Z.AI General API)

```dotenv
DECISION_PROVIDER=jev
REPLY_PROVIDER=glm
TYPESAFE_API_KEY=your-jev-key
GLM_API_KEY=your-zai-general-api-key
GLM_MODEL=glm-4.7
```

Restart after changing `.env.local`. This pair does not need an OpenAI key. GLM only composes replies; Jev assessment, policy, persistence and incident deduplication are unchanged. The adapter uses the Z.AI **General API**, not Coding Plan: `https://api.z.ai/api/paas/v4/chat/completions`. The model is configurable; `glm-4.7` is the initial reply-writing default, not a claim of cheapest/best. GLM-5.3 uses low thinking; the default disables thinking to avoid unnecessary reasoning for reply composition.

GLM JSON mode is followed by local schema and citation validation; it is not strict server-enforced JSON Schema. Truncated, malformed or unsupported responses fail the run safely, and retry reuses any completed incident. No hidden provider fallback or automatic retry. Run `npm run eval -- --live` after configuring credentials to test the full pair. **For submission, select OpenAI replies again to satisfy the assignment's GPT requirement.**

Contract references: [Z.AI Chat Completion](https://docs.z.ai/api-reference/llm/chat-completion), [JSON output](https://docs.z.ai/guides/capabilities/struct-output).

## HTTP contract

| Method | Path                               | Behavior                                                        |
| ------ | ---------------------------------- | --------------------------------------------------------------- |
| POST   | `/api/tickets`                     | Persist a thread, assess it and return reply + decision (201)   |
| POST   | `/api/conversations/{id}/messages` | Append customer/operator turn and return updated decision (200) |
| GET    | `/api/conversations/{id}`          | Messages, runs, decisions, tool audit and side effects          |
| GET    | `/api/health`                      | Liveness only; does not probe providers                         |

All POST requests require `Content-Type: application/json` and `Idempotency-Key` (1–128 ASCII letters/digits or `._:-`). A duplicate completed request replays its original response with `Idempotency-Replayed: true`. Same key + different normalized payload returns 409. Keys are scoped by endpoint/conversation. Use a new key for each **new** user turn. A new key on `/api/tickets` intentionally creates a new ticket.

Example (PowerShell; also see the cross-platform demo script):

```powershell
$ticket = @{
  customer = @{ plan = 'pro'; region = 'Thailand' }
  messages = @(@{ role = 'customer'; content = 'เปลี่ยนธีมเป็นโหมดมืดยังไงครับ' })
} | ConvertTo-Json -Depth 6
$headers = @{ 'Idempotency-Key' = 'theme-demo-001' }
$result = Invoke-RestMethod 'http://127.0.0.1:3000/api/tickets' -Method Post -ContentType 'application/json; charset=utf-8' -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes($ticket))
$result | ConvertTo-Json -Depth 12
Invoke-RestMethod "http://127.0.0.1:3000/api/conversations/$($result.conversation_id)"
```

```sh
curl http://127.0.0.1:3000/api/tickets -H "Content-Type: application/json" -H "Idempotency-Key: theme-001" -d '{"customer":{"plan":"pro"},"messages":[{"content":"How do I enable dark mode?"}]}'
```

Customer metadata supports `plan`, `region`, `seats`, `tenure_months`, `prior_tickets`, and `daily_active`. Messages support `role` (`customer` default or `operator`), `content`, and optional ISO 8601 `timestamp`. Submit a thread oldest-to-newest: array/arrival order is authoritative; timestamps are retained as evidence. Assistant messages cannot be supplied by a caller. Maximum body: 128 KiB; input message: 6,000 characters; initial thread: 20 messages; continuation bounded to 60 messages / 60,000 existing + incoming characters. Start a separate conversation when the bounded demo context is exhausted.

Responses contain `conversation_id`, `run_id`, `reply`, `citation_ids`, `decision`, `incident`, `mode`, and `reply_provider`. Decision includes urgency, extracted fields, next action, specialist recommendation, policy reasons, document IDs, and tools called. Provider probabilities, model ID, tokens, prompt version, and timings are retained in the audit.

Errors use `{ "error": { "code", "message", "request_id", "details" } }`: 400 malformed JSON/missing key; 404 unknown conversation; 409 conflicting key/active conversation; 413 oversized body; 415 wrong content type; 422 invalid fields; 503 retryable provider failure. Configuration/internal failures return a generic 500 and do not expose keys or provider error bodies.

## Safe retries and recovery

- SQLite transactions atomically save input and claim a run. A partial unique index permits one unfinished run per conversation. Concurrent requests get 409 rather than interleaving state.
- Save assessment + decision before any side effect. Retry reuses this checkpoint; it cannot silently choose a different action after an uncertain effect.
- `open_incident` uses `incident:{conversation_id}:v1`. Both caller and mock provider persist it. The provider stores a payload fingerprint and returns the same incident for repeated keys. This deliberately allows **one incident per conversation**, not one incident per turn.
- The provider has a separate database/commit. A timeout after its commit leaves local status `unknown`; retry with the same key obtains the existing incident. No claim of exactly-once delivery: this is repeated delivery with provider-side deduplication.
- A failed run returns its IDs with 503. Repeat the **original body and key**. New messages are blocked until it completes. After a hard crash, an active lease expires within 120 seconds; repeat the original request after that. Completed responses survive restart. Ownership checks stop an expired worker from committing a reply.
- Storage must remain on the same local disk. Do not deploy this file-based implementation across replicas/serverless instances. Incident closure, reopening, cross-ticket incident merging, and a run-cancellation endpoint are intentionally out of scope.

To see an uncertain outcome, set `INCIDENT_MODE=timeout_after_commit`, restart, and submit a fresh outage ticket. First request returns 503; retry returns the original incident. `fail_before_commit` simulates an unavailable incident service; reset it to `normal` before retrying. Only environment configuration can enable failure simulation.

## Tests and evaluation

```sh
npm run check
npm run smoke
npm run eval
```

- `check`: TypeScript, deterministic policy/service/provider-contract tests, production build.
- `smoke`: starts an isolated production Next.js process, simulates a remote commit + timeout, stops/restarts the process, retries over HTTP and checks persistence/deduplication. It uses temporary databases and no live API keys.
- `eval`: **offline mock baseline**, ten authored labelled cases, urgency/action/language/incident checks, retrieval checks, p50/p95 and a JSON report under `evals/reports/`. The keyword stub is intentionally weak; this is a working offline harness, not an AI benchmark.
- `npm run eval -- --live`: uses the configured live provider pair, makes billable calls and reports actual model usage. Side effects remain simulated. Set Jev/OpenAI mode in `.env.local` first. To compare cost/quality, run the same cases in Jev/OpenAI and OpenAI/OpenAI modes. No cost or speed advantage is assumed.

Review `evals/cases.json` labels before tuning. Sample triage labels are our interpretation, not labels supplied by the assignment. Expand the held-out set with Thai/English paraphrases, uncertain evidence, misleading docs, prompt injection, and operator corrections. A relevance match does not prove an answer is sufficient. Thresholds in `lib/policy.ts` are initial policy settings, not validated accuracy guarantees. Generated text still needs live checks for unsupported claims and language quality.

## Project map

`app/api/` is HTTP transport. `lib/triage.ts` coordinates the bounded workflow; `models.ts` contains providers and FAQ assessment; `policy.ts` controls autonomy; `tools.ts` defines contracts and the incident executor; `db.ts` owns persistence. `prompts.ts` contains versioned instructions with rationale. `data/faq.json` is clearly fictional. `WRITEUP.md` covers trade-offs and sample-specific failures.

Structured stdout logs carry request/run/audit IDs. Detailed input, tool arguments/results, assessments and replies live in SQLite and can be read through the history endpoint. The application is deliberately local and unauthenticated per assignment; stored conversations contain customer text. There is no deployment or cloud setup.

### Implementation references

- [TypeSafe quick start: actual REST request and response](https://docs.typesafe.ai/introduction/quickstart)
- [TypeSafe primitives and independent batched questions](https://docs.typesafe.ai/primitives)
- [TypeSafe confidence semantics](https://docs.typesafe.ai/confidence)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

Contract implementations were checked against these docs. HTTP fixture tests validate our adapters; they do not establish live account access or model quality.

### TypeSafe skill review (2026-09-22)

The official skill is installed in `.agents/skills/typesafe-ai`; future project work follows `AGENTS.md`. See `JEV-REVIEW.md` for the review and regression coverage. Jev still uses one call: five Choices, seven impact/presence Nouls and two Nouls per FAQ (usefulness and complete answer support). FAQ scores are probabilities of useful guidance, not graded relevance. Only sufficiency from a selected document can authorize an automatic answer. Questions needing a combination of documents may conservatively escalate.

For Jev, `classification_confidence` is urgency Choice confidence, not the minimum over unrelated descriptive fields or a probability that the workflow is correct. On TypeSafe rate-limit/overload, the API returns a `Retry-After` hint; wait before retrying the same payload/key and increase backoff for repeated failures. No silent provider switch or hidden retry was added.
