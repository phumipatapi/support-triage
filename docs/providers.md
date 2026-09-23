# Optional provider adapters

The submission's default live path uses **OpenAI for both assessment and replies**. Jev + OpenAI is the supported optional hybrid. Both use the same policy, tools, persistence and HTTP contract; see [README.md](../README.md).

## Jev assessment

```dotenv
DECISION_PROVIDER=jev
REPLY_PROVIDER=openai
TYPESAFE_API_KEY=your-typesafe-key
OPENAI_API_KEY=your-openai-key
JEV_MODEL=jev-latest
```

The TypeSafe adapter calls `https://api.typesafe.ai/v1/systemone`. It batches independent Choices and Nouls, including FAQ usefulness and answer-support judgments. FAQ probabilities are judgments of defined propositions, not verified transaction facts or measures of severity. The local TypeSafe skill is retained under `.agents/skills/typesafe-ai` for implementation guidance.

Jev's `classification_confidence` uses the urgency Choice. It is not the probability the entire workflow is correct. Knowledge sufficiency must come from a selected document. This is intentionally conservative when multiple documents are needed together. Initial policy thresholds are not calibrated accuracy guarantees.

## GLM reply adapter (experimental)

```dotenv
DECISION_PROVIDER=jev
REPLY_PROVIDER=glm
TYPESAFE_API_KEY=your-typesafe-key
GLM_API_KEY=your-zai-key
GLM_MODEL=glm-4.7
```

The adapter targets the Z.AI General API at `https://api.z.ai/api/paas/v4/chat/completions`, not the Coding Plan endpoint. It requests JSON output and validates the response schema and citation IDs locally. Truncated or malformed output fails the run; any completed incident remains reusable on retry. It does not silently fall back to another model.

This option is retained to make prior local experiments reproducible; it is **not required for review**, is not a cost/speed recommendation, and Jev + GLM alone does not satisfy the assignment's OpenAI-model constraint. For submission use `REPLY_PROVIDER=openai`. Availability, rate limits and quality depend on the account/model; run the live eval before changing a deployed configuration.

## Configuration and failures

Restart after editing `.env.local`; existing shell environment variables take precedence. Provider calls use 20-second timeouts without hidden retries. A provider failure is returned as a structured error. Retry the original HTTP body and idempotency key, observing any `Retry-After` hint. Do not rotate to a fresh request key to recover an uncertain side effect.

Both reply adapters share bounded language and unsupported-claim guards. For an approved specialist/human handoff in English or Thai, a draft rejected by these guards may be replaced with a deterministic advisory reply, marked `reply_source: policy_fallback`, without citations or another model call. Audit metadata keeps the original provider usage and rejection code. This is not a provider switch or evidence that the generated answer passed. Auto-responses, unsupported response languages, malformed replies and provider failures do not use this fallback; retryable errors remain visible.
