import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const flags = new Set(process.argv.slice(2));
if (
  [...flags].some(
    (flag) => !["--offline", "--openai", "--start"].includes(flag),
  ) ||
  (flags.has("--offline") && flags.has("--openai"))
) {
  console.error(
    "Usage: node scripts/setup.mjs [--offline | --openai] [--start]",
  );
  process.exit(1);
}
const existing = existsSync(".env.local");
const local = existing ? parseEnv(readFileSync(".env.local", "utf8")) : {};
const environment = { ...local, ...process.env };
const explicit = flags.has("--offline")
  ? "mock"
  : flags.has("--openai")
    ? "openai"
    : undefined;
const decision =
  explicit ||
  environment.DECISION_PROVIDER ||
  (environment.OPENAI_API_KEY?.trim() ? "openai" : "mock");
const reply =
  explicit ||
  environment.REPLY_PROVIDER ||
  (decision === "mock" ? "mock" : "openai");
if (
  (decision === "openai" || reply === "openai") &&
  !environment.OPENAI_API_KEY?.trim()
) {
  console.error(
    "OPENAI_API_KEY is required. Set it in the environment or .env.local, or use npm run setup:offline.",
  );
  process.exit(1);
}
if (decision === "jev" && !environment.TYPESAFE_API_KEY?.trim()) {
  console.error(
    "TYPESAFE_API_KEY is required for Jev. Set it in the environment or .env.local.",
  );
  process.exit(1);
}
if (reply === "glm" && !environment.GLM_API_KEY?.trim()) {
  console.error(
    "GLM_API_KEY is required for GLM replies. Set it in the environment or .env.local.",
  );
  process.exit(1);
}
if (!existing) {
  const example = readFileSync(".env.example", "utf8")
    .replace(/^DECISION_PROVIDER=.*$/m, "DECISION_PROVIDER=" + decision)
    .replace(/^REPLY_PROVIDER=.*$/m, "REPLY_PROVIDER=" + reply);
  // Do not persist injected credentials or replace an existing user's configuration.
  writeFileSync(".env.local", example, { flag: "wx", mode: 0o600 });
}
mkdirSync("storage", { recursive: true });
console.log(
  (existing ? "Preserved existing" : "Created") +
    " .env.local. Selected providers: " +
    decision +
    " + " +
    reply +
    ".",
);
console.log(
  decision === "mock" && reply === "mock"
    ? "Offline mode: no external model calls."
    : "Live mode: API calls may incur charges; only the incident tool is simulated.",
);
if (!flags.has("--start")) {
  console.log(
    explicit && existing
      ? "Configuration was not changed. Add --start to run with this temporary provider override."
      : "Run npm run dev, then npm run chat in another terminal.",
  );
} else {
  loadEnvFile(".env.local");
  process.env.DECISION_PROVIDER = decision;
  process.env.REPLY_PROVIDER = reply;
  // Stay in one process so Ctrl+C and process shutdown cannot leave a child server behind.
  const { tsImport } = await import("tsx/esm/api");
  await tsImport(pathToFileURL(resolve("server.ts")).href, import.meta.url);
}
