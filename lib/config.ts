import { z } from "zod";

const Config = z.object({
  DECISION_PROVIDER: z.enum(["mock", "jev", "openai"]).default("openai"),
  REPLY_PROVIDER: z.enum(["mock", "openai", "glm"]).default("openai"),
  GLM_API_KEY: z.string().optional(),
  GLM_MODEL: z.string().min(1).default("glm-4.7"),
  OPENAI_API_KEY: z.string().optional(),
  TYPESAFE_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  JEV_MODEL: z.string().min(1).default("jev-latest"),
  DATABASE_PATH: z.string().default("storage/triage.sqlite"),
  INCIDENT_DATABASE_PATH: z.string().default("storage/incidents.sqlite"),
  INCIDENT_MODE: z
    .enum(["normal", "timeout_after_commit", "fail_before_commit"])
    .default("normal"),
  INCIDENT_LATENCY_MS: z.coerce.number().int().min(0).max(1000).default(30),
});
export type AppConfig = z.infer<typeof Config>;
export function readConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const c = Config.parse(env);
  if (
    (c.DECISION_PROVIDER === "openai" || c.REPLY_PROVIDER === "openai") &&
    !c.OPENAI_API_KEY
  )
    throw new Error("OPENAI_API_KEY is required for the selected provider.");
  if (c.DECISION_PROVIDER === "jev" && !c.TYPESAFE_API_KEY)
    throw new Error("TYPESAFE_API_KEY is required for Jev.");
  if (c.REPLY_PROVIDER === "glm" && !c.GLM_API_KEY)
    throw new Error("GLM_API_KEY is required for GLM replies.");
  if (c.DECISION_PROVIDER !== "mock" && c.REPLY_PROVIDER === "mock")
    throw new Error(
      "Live decisions require REPLY_PROVIDER=openai or glm. Use mock/mock for offline runs.",
    );
  return c;
}
