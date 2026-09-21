import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const base = process.env.BASE_URL || "http://127.0.0.1:3000";
const samples = JSON.parse(
  readFileSync(new URL("../data/sample-tickets.json", import.meta.url), "utf8"),
);
const sample = samples.find((s) => s.id === process.argv[2]) || samples[1];
async function post(path, body, key) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data));
  return { data, replay: r.headers.get("idempotency-replayed") };
}
const key = randomUUID();
const initial = await post("/api/tickets", sample.ticket, key);
console.log("Initial triage:", JSON.stringify(initial.data, null, 2));
const replay = await post("/api/tickets", sample.ticket, key);
console.log(
  "Same request replayed:",
  replay.replay,
  "same incident:",
  initial.data.incident?.incident_id === replay.data.incident?.incident_id,
);
const followup = await post(
  `/api/conversations/${initial.data.conversation_id}/messages`,
  {
    role: "operator",
    content: "ช่วยสรุปสิ่งที่ยังต้องตรวจสอบและขั้นตอนถัดไปให้หน่อยครับ",
  },
  randomUUID(),
);
console.log("Follow-up:", JSON.stringify(followup.data, null, 2));
console.log(
  "Audit trail:",
  base + `/api/conversations/${initial.data.conversation_id}`,
);
