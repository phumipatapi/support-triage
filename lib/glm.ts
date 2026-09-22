import { z } from "zod";
import type { AppConfig } from "./config";
import { AppError } from "./errors";
import { REPLY_SYSTEM, PROMPT_VERSION } from "./prompts";
import type { ReplyInput, ReplyResult } from "./models";
import faqs from "../data/faq.json";

const Reply = z
  .object({
    reply: z.string().trim().min(1).max(6000),
    citation_ids: z.array(z.string()),
  })
  .strict();
const Completion = z.object({
  id: z.string(),
  model: z.string(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string(),
        message: z.object({
          role: z.literal("assistant"),
          content: z.string().nullable(),
          tool_calls: z.array(z.unknown()).optional(),
        }),
      }),
    )
    .length(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
    })
    .optional(),
});

// Z.AI General API; never send these credentials to OpenAI or a Coding Plan endpoint.
export async function glmReply(
  config: AppConfig,
  input: ReplyInput,
  fetcher: typeof fetch = fetch,
): Promise<ReplyResult> {
  const started = performance.now();
  const selected = faqs.filter((f) =>
    input.decision.knowledge_ids.includes(f.id),
  );
  const model = config.GLM_MODEL;
  const response = await fetcher(
    "https://api.z.ai/api/paas/v4/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.GLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 1600,
        // GLM-5.3 requires thinking; earlier supported models can disable it for reply writing.
        ...(model.toLowerCase().startsWith("glm-5.3")
          ? { thinking: { type: "enabled" }, reasoning_effort: "low" }
          : { thinking: { type: "disabled" } }),
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              REPLY_SYSTEM +
              ' Return exactly one JSON object with keys "reply" (string) and "citation_ids" (array of FAQ ID strings). No markdown fences or additional keys.',
          },
          {
            role: "user",
            content: JSON.stringify({ ...input, faq: selected }),
          },
        ],
      }),
    },
  );
  if (!response.ok) {
    const raw = response.headers.get("retry-after");
    const seconds =
      raw && /^\d+$/.test(raw)
        ? Number(raw)
        : raw
          ? Math.ceil((Date.parse(raw) - Date.now()) / 1000)
          : NaN;
    throw new AppError(
      503,
      "glm_unavailable",
      `GLM returned HTTP ${response.status}.`,
      response.status === 429
        ? {
            retry_after_seconds:
              Number.isFinite(seconds) && seconds > 0 ? seconds : 2,
          }
        : undefined,
    );
  }
  let completion: z.infer<typeof Completion>;
  let reply: z.infer<typeof Reply>;
  try {
    completion = Completion.parse(await response.json());
    const choice = completion.choices[0];
    if (
      choice.finish_reason !== "stop" ||
      choice.message.tool_calls?.length ||
      !choice.message.content
    )
      throw new Error("Incomplete reply");
    reply = Reply.parse(JSON.parse(choice.message.content));
    if (
      reply.citation_ids.some(
        (id) => !input.decision.knowledge_ids.includes(id),
      )
    )
      throw new Error("Unsupported citation");
  } catch {
    throw new AppError(
      503,
      "invalid_glm_reply",
      "GLM did not return a complete, valid reply with supported citations. Retry the same request key.",
    );
  }
  return {
    ...reply,
    metadata: {
      provider: "glm",
      model: completion.model,
      response_id: completion.id,
      usage: completion.usage,
      prompt_version: PROMPT_VERSION,
      latency_ms: Math.round(performance.now() - started),
    },
  };
}
