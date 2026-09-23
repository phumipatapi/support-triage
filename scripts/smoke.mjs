import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
async function start(useSetup = false) {
  server = spawn(
    process.execPath,
    useSetup
      ? [resolve("scripts/setup.mjs"), "--offline", "--start"]
      : [resolve("dist/server.mjs")],
    {
      env: {
        ...process.env,
        PORT: String(port),
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
function checkSetup() {
  const cleanEnv = { ...process.env };
  for (const key of [
    "OPENAI_API_KEY",
    "TYPESAFE_API_KEY",
    "GLM_API_KEY",
    "DECISION_PROVIDER",
    "REPLY_PROVIDER",
  ])
    delete cleanEnv[key];
  for (const [name, env, args, expected] of [
    ["offline", cleanEnv, [], "mock"],
    [
      "reviewer",
      { ...cleanEnv, OPENAI_API_KEY: "smoke-placeholder-not-a-real-key" },
      [],
      "openai",
    ],
  ]) {
    const folder = join(dir, "setup-" + name);
    mkdirSync(folder);
    copyFileSync(".env.example", join(folder, ".env.example"));
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/setup.mjs"), ...args],
      {
        cwd: folder,
        env,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const generated = readFileSync(join(folder, ".env.local"), "utf8");
    assert.ok(generated.includes("DECISION_PROVIDER=" + expected));
    assert.ok(generated.includes("REPLY_PROVIDER=" + expected));
    assert.ok(!generated.includes("smoke-placeholder-not-a-real-key"));
    const custom =
      "# preserve exactly\nDECISION_PROVIDER=openai\nREPLY_PROVIDER=openai\nOPENAI_API_KEY=local-placeholder-not-a-real-key\n";
    writeFileSync(join(folder, ".env.local"), custom);
    const preserved = spawnSync(
      process.execPath,
      [resolve("scripts/setup.mjs"), "--offline"],
      {
        cwd: folder,
        env: cleanEnv,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      },
    );
    assert.equal(preserved.status, 0, preserved.stderr);
    assert.equal(readFileSync(join(folder, ".env.local"), "utf8"), custom);
    assert.ok(preserved.stdout.includes("mock + mock"));
  }
}
async function runChat(input, stateFile) {
  const chat = spawn(process.execPath, [resolve("scripts/chat.mjs")], {
    env: { ...process.env, BASE_URL: base, CHAT_STATE_FILE: stateFile },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  chat.stdout.on("data", (chunk) => {
    output += chunk;
  });
  chat.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const timeout = setTimeout(() => chat.kill(), 20_000);
  const ended = once(chat, "exit");
  chat.stdin.end(input);
  try {
    assert.equal((await ended)[0], 0, output);
  } finally {
    clearTimeout(timeout);
  }
  return output;
}
try {
  checkSetup();
  await start();
  const chatStateFile = join(dir, "chat-session.json");
  const chatOutput = await runChat(
    "How do I enable dark mode?\n/operator\nWhat should I check next?\n/exit\n",
    chatStateFile,
  );
  assert.equal((chatOutput.match(/ผู้ช่วย:/g) || []).length, 2);
  const savedConversation = JSON.parse(
    readFileSync(chatStateFile, "utf8"),
  ).conversation;
  assert.ok(savedConversation);
  const resumedOutput = await runChat(
    "/status\n/history\n/new\n/exit\n",
    chatStateFile,
  );
  assert.ok(resumedOutput.includes("เคสปัจจุบัน: " + savedConversation));
  assert.ok(resumedOutput.includes("/api/conversations/" + savedConversation));
  assert.ok(resumedOutput.includes("What should I check next?"));
  assert.ok(resumedOutput.includes("เริ่มเคสใหม่แล้ว"));
  assert.equal(
    JSON.parse(readFileSync(chatStateFile, "utf8")).conversation,
    undefined,
  );
  const failedChat = await runChat(
    "All coworkers cannot access the app: error 500. Our core work is blocked.\n/exit\n",
    chatStateFile,
  );
  assert.ok(failedChat.includes("ยังไม่สำเร็จ (503)"));
  const pending = JSON.parse(readFileSync(chatStateFile, "utf8")).pending;
  assert.ok(pending.key);
  const blockedNew = await runChat("/new\n/exit\n", chatStateFile);
  assert.ok(blockedNew.includes("ยังมีคำขอที่ไม่ทราบผล"));
  assert.equal(
    JSON.parse(readFileSync(chatStateFile, "utf8")).pending.key,
    pending.key,
  );
  const retriedChat = await runChat("/retry\n/exit\n", chatStateFile);
  assert.ok(retriedChat.includes("ความเร่งด่วน: critical"));
  const recoveredChatState = JSON.parse(readFileSync(chatStateFile, "utf8"));
  assert.equal(recoveredChatState.pending, undefined);
  const chatHistory = await (
    await fetch(base + "/api/conversations/" + recoveredChatState.conversation)
  ).json();
  assert.equal(chatHistory.messages.length, 2);
  assert.equal(chatHistory.side_effects.length, 1);
  assert.equal(chatHistory.side_effects[0].attempts, 2);
  const malformed = await fetch(base + "/api/tickets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "invalid_json");
  const oversized = await fetch(base + "/api/tickets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "x".repeat(129 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  const wrongType = await fetch(base + "/api/tickets", {
    method: "POST",
    body: "hello",
  });
  assert.equal(wrongType.status, 415);
  const invalidId = await fetch(base + "/api/conversations/not-a-uuid");
  assert.equal(invalidId.status, 422);
  assert.ok(invalidId.headers.get("x-request-id"));
  assert.equal((await fetch(base + "/missing")).status, 404);
  const first = await post("/api/tickets", ticket, "restart-test");
  assert.equal(first.status, 503);
  const failure = await first.json();
  const id = failure.error.details.conversation_id;
  await stop();
  await start(true);
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
          "real Express HTTP endpoints",
          "setup chooses OpenAI with an injected key, defaults offline without one, and preserves existing credentials",
          "setup --offline --start launches the source server without overwriting configured live providers",
          "interactive chat: initial message, follow-up, persisted resume, history and new conversation",
          "chat persists uncertain requests, blocks accidental new cases and retries with the same key after restart",
          "malformed JSON, body limit, media type, UUID validation and 404",
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
