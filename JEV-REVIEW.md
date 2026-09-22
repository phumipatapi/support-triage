# Jev integration review — 2026-09-22

Installed the official project-local TypeSafe skill for Codex using `npx skills add typesafe-ai/skills --skill typesafe-ai --agent codex --yes`. Source and content hash are in `skills-lock.json`; the MIT license is included. Future Jev work is guided by `AGENTS.md`.

## Confirmed against live documentation

The existing REST endpoint, Bearer authentication, `model` / object-valued `state` / `questions` request, and Choice/Noul response structure were correct. Questions are independent and can be batched; each explicitly references the relevant thread or FAQ path. No SDK migration is necessary.

Noul FAQ ranking is valid: its value is the probability that the document provides useful guidance, **not a degree of relevance or an accuracy guarantee**. TypeSafe's reranking cookbook uses Noul for a well-defined binary relationship. Score would be appropriate if we wanted graded relevance levels. We retained Noul and clarified true/false criteria.

## Changes made

- Replaced the repeated general LLM prompt in every Jev question with concise shared evidence-handling instructions and question-specific criteria. Choice descriptions now distinguish each category explicitly.
- Removed the minimum over all Choice confidences. Uncertainty in sentiment, language or other descriptive fields no longer blocks incident automation. The compatibility field `classification_confidence` now contains **urgency Choice confidence** for new Jev assessments; independent impact Noul thresholds remain mandatory. Raw confidences are preserved in the audit. It is not joint workflow confidence.
- Added one independent Noul per FAQ asking whether that document alone can answer all current issues. Sufficiency is derived only from the top-three documents actually selected for GPT. Mere relevance, or support from an omitted document, cannot authorize an automatic answer. This conservative rule may escalate questions that require combining multiple documents. All 24 questions still use **one Jev call**.
- Validate token usage and ensure a Choice agrees with the maximum of its probability distribution; retain the existing type, range, key and probability-sum checks.
- Store exact Jev questions with model input in the audit, including failed attempts. Prompt/policy versions advanced to v2; durable checkpoints from earlier runs remain replayable as their original decisions.
- Preserve provider rate-limit/overload backoff guidance as HTTP `Retry-After`, with a two-second fallback. There are no hidden automatic retries; clients should wait at least that long and use exponential backoff for repeated 429/529 upstream failures, preserving the original request key.

## Verification boundary

Regression tests cover batching, irrelevant-field confidence, low urgency confidence, relevant-but-insufficient evidence, omitted evidence, malformed output, and backoff propagation. The existing workflow/restart tests remain in place. No API keys are configured, so **no live Jev accuracy, response quality, latency or cost has been established**. Threshold tuning and live eval remain necessary.

Sources read on 2026-09-22:

- [TypeSafe skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md)
- [HTTP API contract](https://docs.typesafe.ai/api)
- [Choice and unused-branch uncertainty](https://docs.typesafe.ai/primitives/choice)
- [Noul semantics](https://docs.typesafe.ai/primitives/noul)
- [Score semantics](https://docs.typesafe.ai/primitives/score)
- [Re-ranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe)
- [Confidence](https://docs.typesafe.ai/confidence)
