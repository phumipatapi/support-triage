# Validation record

Environment: Windows, Node.js 22.23.1, npm 10.9.0. Validated locally on 2026-09-21.

- TypeScript validation and production Next.js build: passed.
- Deterministic tests: policy and permissions; provider HTTP contracts; request validation; simultaneous duplicates; idempotency conflicts; durable history; failure before provider commit; timeout after provider commit; reply failure after a successful effect; blocking a new turn while recovery is pending.
- Real HTTP smoke: starts a production server, receives 503 after a simulated remote commit, stops and restarts the process, retries to recover the original incident, replays the saved response, continues the conversation, and checks one side effect in the persisted audit.
- Offline eval: ten labelled scenarios passed with the **mock baseline**. This is a check of the eval harness and policy flow, not evidence of Jev/GPT accuracy. Synthetic mock latency is not a model latency measurement.
- API credentials were not available during implementation. No live Jev or GPT calls were made; live provider availability, Thai understanding, grounding and cost remain unverified. Run `npm run eval -- --live` with configured credentials to measure them.

Commands: `npm run check`, `npm run smoke`, `npm run eval`. For exact current results, rerun these commands; generated eval reports are deliberately excluded from Git.

2026-09-22: Reviewed Jev using the installed official TypeSafe skill and live API/primitives/cookbook docs. Added tests for branch-specific confidence, answer sufficiency on selected FAQ, Choice consistency and rate-limit backoff. See `JEV-REVIEW.md`. Live credentials remain unavailable.

Subsequent checks: a supplied Jev key successfully assessed all three sample tickets using `jev-1.13.0`; raw sanitized results are delivered separately in `jev-live-report.json`. This did not test generated replies or execute incidents. Added a Z.AI General API GLM reply adapter with fixture tests for credentials, wire format, JSON validation, citation restrictions, incomplete output and rate limits. GLM live quality remains unverified until a GLM key is configured.

2026-09-22: Live Jev + Z.AI General API GLM validation completed on the three supplied sample tickets using isolated temporary databases and mocked incident effects. The first run exposed unsupported claims of routing and verified payment status in generated prose. Updated the GLM reply prompt to provide explicit execution facts, omit internal decision reasons, and require recommendation/uncertainty wording. The second run produced grounded replies in the three inspected samples; prompt rules are not a guarantee of grounding on unseen inputs.

Final observed end-to-end latency: billing 8.1 s, Thai outage 10.5 s, theme bug 7.6 s. Jev took about 1.0-1.1 s; GLM took 6.6-9.5 s. Models reported: jev-1.13.0 and glm-4.7. Billing was high priority and recommended billing routing; theme bug was medium priority and recommended engineering routing. The outage was critical but urgency confidence 0.71 was below the policy threshold 0.75, so it required human review and created no incident. This is a limited three-case observation, not a passed model accuracy benchmark or proof of the assignment's expected automatic incident behavior.

Sanitized latest output: ../jev-glm-live-report.json. Initial output retained separately for comparison. After the prompt change, TypeScript, all 41 tests, production build and the restart/idempotency HTTP smoke test passed. Local environment now selects Jev decisions and GLM replies; default example configuration remains offline mock mode. Live OpenAI reviewer-mode validation remains outstanding.
