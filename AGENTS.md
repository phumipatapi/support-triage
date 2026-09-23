# Project guidance

For Jev / TypeSafe work, read `.agents/skills/typesafe-ai/SKILL.md` and follow its live-documentation workflow. The skill is installed locally and pinned by `skills-lock.json`.

Keep the current Express/TypeScript/SQLite stack. Batch independent Jev questions in one request. Code owns policy and side effects; GPT or GLM only writes replies. Preserve the OpenAI reviewer mode required by the assignment. Do not confuse mock tests or probability-derived confidence with verified model accuracy.

Validate changes with `npm run check`; run `npm run smoke` when changing workflow, persistence, or HTTP behavior. Live eval requires explicitly configured provider keys. Never commit keys, runtime databases, or `.env.local`.
