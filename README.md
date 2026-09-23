# Support Ticket Triage Service

An API that reads a support thread, classifies urgency, extracts customer information, retrieves relevant FAQ documents and recommends the next action. Conversations, decisions and tool attempts survive a restart. A terminal client lets an operator test multiple turns without building a UI.

**Stack:** Express, TypeScript, Zod and SQLite. **Reviewer path:** OpenAI only; no TypeSafe account required. The optional hybrid uses Jev for assessment and OpenAI for replies. Financial actions and team notifications are never executed. The incident tool performs a real durable write to a separate SQLite database representing a mock incident provider.

## Quick start

Requires **Node.js 22.13+ and npm**. Extract the submission (including its `.git` directory), or clone the repository, then open a terminal in `support-triage`.

### Review with your OpenAI key

PowerShell:

```powershell
$env:OPENAI_API_KEY = 'YOUR_OPENAI_API_KEY'
npm run setup:openai
```

macOS/Linux:

```sh
OPENAI_API_KEY='YOUR_OPENAI_API_KEY' npm run setup:openai
```

This installs the lockfile dependencies, selects OpenAI-only mode, and starts the API at **http://127.0.0.1:3000**. Existing `.env.local` files are preserved: an explicit setup mode overrides providers for that process, rather than rewriting the existing file. The default model is `gpt-4.1-mini`; change `OPENAI_MODEL` to a model available to your account that supports Responses structured outputs. Live requests consume API credits. The key is read from the environment and must not be committed.

For an offline first run, use `npm run setup:offline`. The mock checks service behavior; it does not measure AI quality. `npm run setup` also works: it preserves existing configuration, or selects OpenAI-only for a fresh setup with an injected OpenAI key, otherwise offline mock mode. See `.env.example` for configuration.

SQLite tables are created automatically. `better-sqlite3` normally installs a prebuilt binary; unsupported platforms may require native build tools.

### Try your own conversation

Keep the server running and open another terminal in the same folder:

```sh
npm run chat
```

Type each line and wait for the answer:

```text
My Mac is in dark mode, but the app stays light after selecting System Default.
Also, can I schedule dark mode to turn on at 6pm?
/operator
What has actually been done, and what still needs investigation?
```

The bug should remain unresolved when the scheduling question arrives. Routing to engineering is a recommendation; no team is contacted. `/new` starts a separate ticket, `/customer` switches back to customer messages, `/history` reads the persisted history, `/status` identifies the active case, `/retry` reuses an uncertain request's key and body, and `/exit` quits. The client saves its current conversation and pending request locally in ignored `storage/chat-session.json` so it can resume after reopening. Use a different `CHAT_STATE_FILE` for separate terminal sessions or a different server. Start a new ticket for an unrelated issue rather than combining billing, outage and theme tests into one conversation. See [the Thai guide](START-HERE.th.md) for a walkthrough.

For supplied threads, run `npm run demo`, `npm run demo -- billing-thread` or `npm run demo -- theme-bug-thread`. The demo also retries the initial request and sends an operator follow-up. `BASE_URL` overrides the client URL.

After setup, use `npm run dev` for development or `npm run build` followed by `npm start` for the built server. Both load `.env.local`. `PORT` changes the port; the server binds to `127.0.0.1`.

## Configuration

Keys belong in the server environment or ignored `.env.local`; never in requests or source control. Restart the server after configuration changes. Existing shell environment variables take precedence over the env file.

| Mode | `DECISION_PROVIDER` | `REPLY_PROVIDER` | Required keys |
| --- | --- | --- | --- |
| Submission / reviewer | `openai` | `openai` | `OPENAI_API_KEY` |
| Optional hybrid | `jev` | `openai` | `TYPESAFE_API_KEY`, `OPENAI_API_KEY` |
| Offline baseline | `mock` | `mock` | None |

`OPENAI_MODEL` defaults to `gpt-4.1-mini`; `JEV_MODEL` to `jev-latest`. The hybrid batches independent classification and FAQ judgments in one Jev request. Code applies policy, then GPT writes from the approved decision and observed outcomes. OpenAI-only uses the same contracts and policy. No cost, speed or quality advantage is assumed between modes. An experimental GLM reply adapter is documented separately in [provider options](docs/providers.md); it is not the submission path.

Default storage is `storage/triage.sqlite` and `storage/incidents.sqlite`, configurable with `DATABASE_PATH` and `INCIDENT_DATABASE_PATH`. Both must persist on the same local machine. Use one server process; replicas, shared network filesystems and serverless deployment are outside this implementation's scope. There is deliberately no authentication, tenant isolation or deployment infrastructure.

## HTTP API

| Method | Path | Result |
| --- | --- | --- |
| POST | `/api/tickets` | Create a conversation and initial triage; 201 |
| POST | `/api/conversations/{id}/messages` | Add a customer/operator turn and triage; 200 |
| GET | `/api/conversations/{id}` | Messages, runs, decisions, tool audit and side effects |
| GET | `/api/health` | Liveness only; does not test model credentials |

Every POST requires JSON and an **`Idempotency-Key`** containing 1–128 ASCII letters/digits or `._:-`. Use a fresh key for each new turn; retry the exact original body and key after an uncertain result. Completed duplicates return the saved response with `Idempotency-Replayed: true`. Reusing a key with different normalized content returns 409. Keys are scoped to ticket creation or a specific conversation.

Create a ticket (POSIX shell; use `npm run chat` on any supported platform):

```sh
curl -i http://127.0.0.1:3000/api/tickets \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: example-ticket-1' \
  -d '{"customer":{"plan":"pro"},"messages":[{"role":"customer","content":"How do I change the app theme?"}]}'
```

Use the returned `conversation_id` below. Replace `CONVERSATION_ID` in both commands:

```sh
curl -i http://127.0.0.1:3000/api/conversations/CONVERSATION_ID/messages \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: example-followup-1' \
  -d '{"role":"operator","content":"What still needs investigation?"}'
curl http://127.0.0.1:3000/api/conversations/CONVERSATION_ID
```

`customer` accepts `plan`, `region`, `seats`, `tenure_months`, `prior_tickets` and `daily_active`; `{}` is valid and defaults unspecified plan/region to unknown. Messages have `role` (`customer` by default, or `operator`), `content` and optional ISO 8601 `timestamp`. Callers cannot insert assistant messages. Supply a thread oldest first: arrival order is authoritative, timestamps are retained as evidence. Limits: 128 KiB body, 6,000 characters per input, 20 initial messages, and bounded conversation context. Start a new conversation when the service returns `conversation_limit`.

The response includes:

| Field | Meaning |
| --- | --- |
| `conversation_id`, `run_id` | Persistent conversation and this processing attempt |
| `reply`, `citation_ids` | Generated reply and supporting fictional FAQ IDs |
| `reply_source` | `model`, `mock` or `policy_fallback`; identifies how the delivered text was produced |
| `decision.urgency` | `critical`, `high`, `medium` or `low` |
| `decision.extracted` | Product area, issue type, customer sentiment and customer language |
| `decision.action`, `specialist`, `reasons` | Approved next step and explanation; routing is advisory |
| `decision.tools_called`, `knowledge_ids` | Tools used in this run and selected references |
| `incident` | Known simulated incident, including one created in an earlier turn, or `null`; not proof of a new creation this turn |
| `mode`, `reply_provider` | Assessment and reply providers used |

Reply language follows the current human turn; an operator asking in Thai can receive a Thai summary of an English customer's ticket. Customer sentiment/language refer to customer evidence, not the operator's tone. English/Thai response checks are deliberately bounded; they are not general multilingual language detection.

Earlier assistant text remains in persisted history but is excluded from new model evidence, so an earlier wrong language or invented action is not treated as a fact. The service supplies current human evidence and actual tool results instead. Bounded guards detect wrong English/Thai output, common false-action claims and advice to postpone a bank dispute. If one rejects a draft for an approved specialist/human handoff in English or Thai, the service returns a deterministic advisory reply marked `reply_source: policy_fallback`. It makes no extra model call or FAQ claim and has no citations. Provider usage and `rejected_draft_code` remain in the audit.

This fallback is not used for `auto_respond`, other/unknown response languages, malformed output or provider failures: those errors return 503 for retry with the same body and key. The guards do not detect every unsupported claim or mixed-language word; a delivered fallback is a successful handoff, not a successful generated answer.

Errors use `{"error":{"code":"...","message":"...","request_id":"...","details":{...}}}`. Expected statuses include 400 invalid JSON/missing key, 404 unknown conversation, 409 conflict/active run, 413 oversized body, 415 wrong content type, 422 invalid fields, and 503 retryable processing failure. Provider bodies and secrets are not exposed. See the error's code and IDs when diagnosing a failed run.

## Tools and autonomy

Tool schemas and implementations are in [lib/tools.ts](lib/tools.ts). This is a bounded workflow, not an unrestricted agent loop:

1. `search_knowledge_base` evaluates the whole small corpus against the thread. Retrieval and assessment share one provider call. Code selects up to three sufficiently relevant FAQ documents; relevance alone does not authorize an automatic answer.
2. Code applies [lib/policy.ts](lib/policy.ts). Low-risk questions with sufficient supporting knowledge may auto-respond; financial issues recommend billing, unresolved bugs recommend engineering, and uncertainty/high impact goes to a human. Initial confidence thresholds are uncalibrated policy settings.
3. Only strong evidence of an ongoing multi-user loss of core service permits `open_incident`. It writes one simulated incident per conversation. There is no refund, entitlement, payment, email, notification or paging tool.
4. The reply writer receives the approved decision, selected FAQ and execution facts. It has no tools. Versioned prompts are in [lib/prompts.ts](lib/prompts.ts). Output schemas/citations, bounded language checks and common false-action patterns are checked in code; factual grounding still needs evaluation.

## Idempotency and failure recovery

SQLite atomically stores input and claims a run; a partial unique index serializes a conversation. Assessment and policy are checkpointed **before** a side effect. The stable operation key `incident:{conversation_id}:v1` is persisted by both caller and mock provider, which also validates the argument fingerprint.

The provider commits independently in a separate database. If its acknowledgement is lost, the caller records `unknown`; retrying the same operation reconciles the existing incident. This is repeated delivery with provider deduplication, not a claim of exactly-once networking. A real integration must offer the same durable idempotency contract.

A failed run returns its IDs and blocks new turns until the original request is retried. Completed responses replay across restarts. After a hard crash, a run lease expires within 120 seconds; retry the original request after that. Ownership checks prevent a stale worker from committing a response. Provider calls have 20-second timeouts and no hidden retries or automatic provider switch. Follow any `Retry-After` hint.

To inspect failure behavior, use `npm run smoke`. It isolates temporary databases, makes the incident provider commit and then time out, restarts the HTTP process, and retries. You can also set `INCIDENT_MODE=timeout_after_commit` or `fail_before_commit`; restore `normal` afterwards. One incident per conversation, no closing/reopening/cross-ticket merging, and no cancellation endpoint are deliberate limits.

## Verification and evaluation

```sh
npm run check
npm run smoke
npm run eval
```

`check` runs TypeScript, deterministic tests and a build. `smoke` exercises production HTTP persistence and safe retries. `eval` runs authored labelled tickets through an offline mock pipeline and writes a JSON report under `evals/reports/`. None of these commands needs a live key. **Offline success is evidence of service and harness behavior, not model accuracy.**

```sh
npm run eval:openai
# Optional hybrid comparison (also requires TYPESAFE_API_KEY):
npm run eval:jev
```

These commands select OpenAI-only or Jev + OpenAI explicitly, without changing `.env.local`. Both incur API usage, with isolated temporary databases and simulated side effects. To use another configured pair, invoke `node --env-file-if-exists=.env.local --import tsx evals/run.ts --live` directly.

The harness evaluates the same authored labels, including multi-turn regressions, records actual provider usage/latency, counts `policy_fallback_turns` separately, and returns a nonzero exit code for failed assertions. Generated reports are `evals/reports/offline.json`, `openai-openai.json` and `jev-openai.json`. Labels are engineering expectations rather than universal ground truth. Review both failed checks and generated prose; schema-valid output can still contain factual errors. Current results and known limitations are in [VALIDATION.md](VALIDATION.md), with submitted measured snapshots under `docs/evaluation/`.

## Code map

| Path | Responsibility |
| --- | --- |
| `server.ts`, `lib/http.ts` | Express transport, validation and HTTP error contract |
| `lib/triage.ts` | Run orchestration and checkpoint/recovery flow |
| `lib/models.ts`, `lib/reply-context.ts`, `lib/prompts.ts` | Provider contracts, reply context and versioned instructions |
| `lib/policy.ts`, `lib/tools.ts` | Decisions, autonomy and incident execution |
| `lib/db.ts` | Conversation, run, audit and side-effect persistence |
| `data/faq.json`, `data/sample-tickets.json` | Six fictional FAQ documents and assignment threads |
| `tests/`, `evals/`, `scripts/` | Tests, labelled eval and runnable clients |

Structured stdout logs include request/run/audit IDs. Detailed input, model judgments, selected documents, decisions and tool outcomes are persisted in SQLite and exposed by the history endpoint. Stored conversations contain customer text; use only test data in this unauthenticated local service. Read [WRITEUP.md](WRITEUP.md) or the [two-page PDF](WRITEUP.pdf) for architecture choices, sample-specific failure analysis and production evaluation plans.

A [Thai translation of the write-up](docs/WRITEUP.th.md) is included for reference.
