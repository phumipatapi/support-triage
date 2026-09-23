# Validation record

Measured on **2026-09-23**, Windows, Node.js 22.23.1 / npm 10.9.0. This is a bounded take-home service, not a production readiness certification. Prompt versions: `triage-v3`, `reply-v3`; policy: `policy-v3`.

## Service verification

| Check | Result |
| --- | --- |
| `npm run check` | TypeScript, **63 deterministic tests**, and Express production bundle passed |
| `npm run smoke` | Real HTTP process, setup selection, terminal sessions, restart persistence and uncertain-side-effect recovery passed |
| `npm run eval` | **12/12 offline mock cases** passed; not model-accuracy evidence |
| `npm audit` | 0 reported vulnerabilities in runtime and development dependencies at this snapshot |
| Write-up | Markdown and visually inspected two-page PDF contain the same content |

A fresh local clone, with no credentials or existing dependencies, passed `npm ci`, `npm run check`, `npm run smoke` and `npm run eval`. The PDF's SHA-256 matched across the clone. Only Windows was executed; macOS/Linux instructions use the same Node entry points but were not run on those operating systems. The installed-key check found none of the three configured credentials in tracked files or Git objects; this is a bounded check, not a general secret-detection guarantee.

The tests exercise classification policy, autonomy thresholds, provider schemas, role/language isolation, malformed HTTP, concurrency, payload/key conflicts, stale-worker ownership, durable replay, failed/unknown tool outcomes and incident retention on later turns. They also verify that a rejected draft can become a marked policy handoff, retains provider metadata in the audit, replays identically and does not repeat its incident or model call.

The smoke test uses isolated temporary databases. It makes the mock incident provider commit before losing its acknowledgement, restarts the server, retries the same request, and observes one incident. It also closes/reopens the terminal client with a pending request and verifies same-key recovery. Setup preserves existing credentials and chooses OpenAI for an injected key; no live key is required for these checks.

## Live provider measurements

These are the final complete live runs against the 12 authored cases, including 15 conversation turns per mode. They use isolated databases and simulated incident effects. The three supplied assignment threads and the English-follow-up/Thai-operator regressions passed the automated checks in both modes.

| Mode | Cases passing every assertion | Urgency | Action | Customer language | Incident | Policy fallback turns | Case p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI assessment + OpenAI reply | **11/12** | 12/12 | 11/12 | 12/12 | 12/12 | 0 | 3,982 / 9,489 ms |
| Jev assessment + OpenAI reply | **10/12** | 12/12 | 10/12 | 12/12 | 12/12 | 0 | 2,250 / 4,704 ms |

Reported models were `gpt-4.1-mini-2025-04-14` and `jev-1.13.0`. Configured aliases were `gpt-4.1-mini` and `jev-latest`. Snapshots retain timestamps, per-case replies/checks, model usage and latency: [OpenAI](docs/evaluation/openai-openai.json), [Jev + OpenAI](docs/evaluation/jev-openai.json), [offline baseline](docs/evaluation/offline.json).

Latency is measured per **case**, including any follow-up turns, not per HTTP request. The sample is tiny, was used repeatedly during development, and is not held out. Runs are stochastic; these observations do not establish a speed/cost advantage, calibrated confidence or general accuracy. The live commands correctly exit nonzero when any assertion fails. Fallback count is separate: a safe template is not a successful generated answer.

### Remaining assertion differences

- OpenAI sent the single-user access failure to **engineering** rather than the expected general human escalation. Urgency remained high and no incident was created. Both choices require a human, but the strict action label failed.
- Jev escalated the simple Thai theme question instead of auto-responding because the evidence did not pass the configured sufficiency gate.
- Jev sent the injected refund request to general human review instead of billing because classification confidence was below threshold. It did not authorize a refund. Thresholds were not weakened to make the score pass.

### Manual prose review: limitations that assertions miss

Passing assertions does **not** establish fully grounded answers. In the final snapshots, OpenAI billing describes reported entries too confidently as unsettled holds and suggests reconciliation is needed before disputing with a bank. The latter paraphrase is not caught by the narrow imperative-pattern guard. A reply also attributes a status-page check to a team when only the customer reported checking it. Jev + OpenAI sometimes adds general advice (waiting for updates or updating software) beyond the FAQ and calls the reported theme behavior a known issue without evidence of an existing engineering investigation.

Earlier iterations produced Thai replies to English follow-ups, false promises of team contact, and imperative advice to delay bank disputes. Role-aware language context and bounded guards now address those observed forms; rejected English/Thai drafts for already-approved handoffs can use a deterministic advisory with `reply_source: policy_fallback` and an audited rejection code. This is deliberately not a semantic verifier. Other languages, paraphrases, explanations of financial state, response completeness and the exact 100-word/600-character prompt target remain imperfect. Human review and a larger held-out grounding evaluation are needed before customer-facing production use.

No payment, refund, account mutation, email or paging capability exists. A risky reply cannot execute those actions. A real incident provider must independently honor the same durable operation-key contract as the mock. Authentication, deployment, incident lifecycle, cross-ticket correlation and recovery cancellation remain out of scope.

## Requirement coverage

| Assignment requirement | Implementation/evidence |
| --- | --- |
| Versioned system prompt, structured triage | `lib/prompts.ts`, `lib/schemas.ts`, `lib/policy.ts` |
| At least two tools and a durable side effect | `search_knowledge_base`, `open_incident`; separate incident SQLite store in `lib/tools.ts` |
| Conversational HTTP API and readback audit | `server.ts`, `lib/http.ts`, persisted messages/runs/tool events |
| Restart persistence and safe retries | `lib/db.ts`, `lib/triage.ts`; concurrency/replay tests and real-process smoke |
| Code-owned autonomy boundary | Policy gates; no financial/notification execution tool |
| Tests, offline labels and observability | `tests/`, `evals/`, structured logs and SQLite audit |
| OpenAI key supplied by reviewer | `npm run setup:openai`; environment key, no TypeSafe requirement |
| Setup/run instructions and two-page write-up | `README.md`, `WRITEUP.md`, `WRITEUP.pdf` |

The submission ZIP includes source and Git history. Local credentials, databases, chat history, dependencies and build output are excluded.
