import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const base = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
const samples = JSON.parse(
  readFileSync(new URL("../data/sample-tickets.json", import.meta.url), "utf8"),
);
const args = process.argv.slice(2);
const sampleId = args.find((arg) => arg !== "--json");
const sample = sampleId ? samples.find((s) => s.id === sampleId) : samples[1];
if (!sample) {
  console.error(
    "Unknown sample. Choose: " + samples.map((s) => s.id).join(", "),
  );
  process.exit(1);
}
async function post(path, body, key) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      "HTTP " +
        response.status +
        ": " +
        (data.error?.message || "Request failed"),
    );
  return { data, replay: response.headers.get("idempotency-replayed") };
}
function show(label, data) {
  console.log("\n" + label + "\nReply: " + data.reply);
  console.log(
    "Urgency: " +
      data.decision.urgency +
      " | Action: " +
      data.decision.action +
      (data.decision.specialist ? " (" + data.decision.specialist + ")" : ""),
  );
  console.log("Why: " + data.decision.reasons.join(" "));
  console.log("FAQ: " + (data.citation_ids.join(", ") || "none"));
  console.log(
    "Incident: " +
      (data.incident
        ? data.incident.incident_id + " (simulated tool)"
        : "none"),
  );
  console.log("Providers: " + data.mode + " + " + data.reply_provider);
  console.log("Reply source: " + (data.reply_source || "unspecified"));
  if (args.includes("--json")) console.log(JSON.stringify(data, null, 2));
}
try {
  console.log(
    "Sample: " +
      sample.id +
      ". Uses the running server's providers; live calls may incur API charges.",
  );
  console.log("Customer conversation:");
  for (const message of sample.ticket.messages)
    console.log("  " + message.content);
  const key = randomUUID();
  const initial = await post("/api/tickets", sample.ticket, key);
  show("1. Initial triage", initial.data);
  const replay = await post("/api/tickets", sample.ticket, key);
  console.log("\n2. Same request replayed: " + (replay.replay === "true"));
  console.log(
    initial.data.incident
      ? "Incident reused: " +
          (initial.data.incident.incident_id ===
            replay.data.incident?.incident_id)
      : "Incident: none in this case; replay returned the saved response.",
  );
  const followupText =
    "ช่วยสรุปสิ่งที่ยังต้องตรวจสอบและขั้นตอนถัดไปให้หน่อยครับ";
  console.log("\nOperator follow-up (Thai): " + followupText);
  const followup = await post(
    "/api/conversations/" + initial.data.conversation_id + "/messages",
    {
      role: "operator",
      content: followupText,
    },
    randomUUID(),
  );
  show("3. Follow-up in the same conversation", followup.data);
  console.log(
    "\nAudit trail: " +
      base +
      "/api/conversations/" +
      initial.data.conversation_id,
  );
  console.log(
    "Add --json to include full API responses. Use npm run chat to type your own messages.",
  );
} catch (error) {
  console.error(
    "Demo failed: " +
      (error instanceof Error ? error.message : "Request failed") +
      ". Check that the server is running.",
  );
  process.exitCode = 1;
}
