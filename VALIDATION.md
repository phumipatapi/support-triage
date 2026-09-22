# Validation record

Environment: Windows, Node.js 22.23.1, npm 10.9.0. Validated locally on 2026-09-21.

- TypeScript validation and production Next.js build: passed.
- Deterministic tests: policy and permissions; provider HTTP contracts; request validation; simultaneous duplicates; idempotency conflicts; durable history; failure before provider commit; timeout after provider commit; reply failure after a successful effect; blocking a new turn while recovery is pending.
- Real HTTP smoke: starts a production server, receives 503 after a simulated remote commit, stops and restarts the process, retries to recover the original incident, replays the saved response, continues the conversation, and checks one side effect in the persisted audit.
- Offline eval: ten labelled scenarios passed with the **mock baseline**. This is a check of the eval harness and policy flow, not evidence of Jev/GPT accuracy. Synthetic mock latency is not a model latency measurement.
- API credentials were not available during implementation. No live Jev or GPT calls were made; live provider availability, Thai understanding, grounding and cost remain unverified. Run `npm run eval -- --live` with configured credentials to measure them.

Commands: `npm run check`, `npm run smoke`, `npm run eval`. For exact current results, rerun these commands; generated eval reports are deliberately excluded from Git.

2026-09-22: Reviewed Jev using the installed official TypeSafe skill and live API/primitives/cookbook docs. Added tests for branch-specific confidence, answer sufficiency on selected FAQ, Choice consistency and rate-limit backoff. See `JEV-REVIEW.md`. Live credentials remain unavailable.
