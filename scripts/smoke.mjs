import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";
const socket = createServer();
socket.listen(0, "127.0.0.1");
await once(socket, "listening");
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const base = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), "triage-smoke-"));
let server;
let logs = "";
async function start() {
  server = spawn(
    process.execPath,
    [
      resolve("node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        DECISION_PROVIDER: "mock",
        REPLY_PROVIDER: "mock",
        DATABASE_PATH: join(dir, "triage.sqlite"),
        INCIDENT_DATABASE_PATH: join(dir, "incidents.sqlite"),
        INCIDENT_MODE: "timeout_after_commit",
        INCIDENT_LATENCY_MS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  server.stdout.on("data", (d) => {
    logs += d;
  });
  server.stderr.on("data", (d) => {
    logs += d;
  });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error("Server stopped: " + logs);
    try {
      if ((await fetch(base + "/api/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Server startup timed out: " + logs);
}
async function stop() {
  if (server && server.exitCode === null) {
    const ended = once(server, "exit");
    server.kill();
    await ended;
  }
}
const ticket = JSON.parse(readFileSync("data/sample-tickets.json", "utf8"))[1]
  .ticket;
async function post(path, body, key) {
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}
try {
  await start();
  const first = await post("/api/tickets", ticket, "restart-test");
  assert.equal(first.status, 503);
  const failure = await first.json();
  const id = failure.error.details.conversation_id;
  await stop();
  await start();
  const recovered = await post("/api/tickets", ticket, "restart-test");
  assert.equal(recovered.status, 201);
  const completed = await recovered.json();
  assert.equal(completed.conversation_id, id);
  assert.equal(completed.decision.urgency, "critical");
  const replay = await post("/api/tickets", ticket, "restart-test");
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.deepEqual(await replay.json(), completed);
  const follow = await post(
    `/api/conversations/${id}/messages`,
    { role: "operator", content: "ตอนนี้ทั้งทีมยังเข้าไม่ได้ครับ" },
    "follow-up",
  );
  assert.equal(follow.status, 200);
  assert.equal(
    (await follow.json()).incident.incident_id,
    completed.incident.incident_id,
  );
  const history = await (await fetch(base + `/api/conversations/${id}`)).json();
  assert.equal(history.messages.length, 7);
  assert.equal(history.side_effects.length, 1);
  assert.equal(history.side_effects[0].attempts, 2);
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "real Next.js HTTP endpoints",
          "remote commit + timeout",
          "process restart with SQLite persistence",
          "same-request replay",
          "multi-turn conversation",
          "one incident across retries and turns",
        ],
        incident_id: completed.incident.incident_id,
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(logs);
  throw e;
} finally {
  await stop();
  rmSync(dir, { recursive: true, force: true });
}
