import { copyFileSync, existsSync, mkdirSync } from "node:fs";
if (!existsSync(".env.local")) copyFileSync(".env.example", ".env.local");
mkdirSync("storage", { recursive: true });
console.log(
  "Ready. Default mode is offline mock. Edit .env.local to enable Jev + GPT.",
);
