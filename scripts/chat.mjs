import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const base = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
const stateFile = resolve(
  process.env.CHAT_STATE_FILE || "storage/chat-session.json",
);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let conversation;
let pending;
let role = "customer";
if (existsSync(stateFile)) {
  try {
    const saved = JSON.parse(readFileSync(stateFile, "utf8"));
    if (
      saved.version !== 1 ||
      saved.base !== base ||
      (saved.conversation && !uuid.test(saved.conversation)) ||
      !["customer", "operator"].includes(saved.role) ||
      (saved.pending &&
        (!uuid.test(saved.pending.key) ||
          !saved.pending.body ||
          !/^\/api\/(tickets|conversations\/[0-9a-f-]{36}\/messages)$/i.test(
            saved.pending.path,
          )))
    ) {
      throw new Error("invalid session");
    }
    ({ conversation, pending, role } = saved);
  } catch {
    console.error(
      "อ่านเคสที่บันทึกไว้ไม่ได้ หรือ BASE_URL เปลี่ยนไป เก็บไฟล์เดิมไว้ก่อนและกำหนด CHAT_STATE_FILE เป็นไฟล์ใหม่",
    );
    process.exit(1);
  }
}
function save() {
  mkdirSync(dirname(stateFile), { recursive: true });
  const temporary = stateFile + ".tmp";
  writeFileSync(
    temporary,
    JSON.stringify({ version: 1, base, conversation, pending, role }),
    { mode: 0o600 },
  );
  renameSync(temporary, stateFile);
}
const actions = {
  auto_respond: "ตอบจาก FAQ",
  route_to_specialist: "แนะนำส่งให้ผู้เชี่ยวชาญ",
  escalate_to_human: "ให้เจ้าหน้าที่ตรวจสอบ",
};
function help() {
  console.log(
    "/new เริ่มเคสใหม่ | /operator ถามในฐานะเจ้าหน้าที่ | /customer เพิ่มข้อความลูกค้า",
  );
  console.log(
    "/retry ลองคำขอเดิมซ้ำ | /history ดูประวัติ | /status ดูเคสปัจจุบัน | /exit ออก",
  );
}
function status() {
  console.log(
    conversation ? "เคสปัจจุบัน: " + conversation : "ยังไม่ได้เริ่มเคส",
  );
  if (pending)
    console.log(
      "มีคำขอที่ยังไม่ทราบผล ใช้ /retry เพื่อรับผลเดิมโดยไม่ทำงานซ้ำ",
    );
}
console.log("Support chat — พิมพ์ปัญหาของลูกค้าได้เลย");
help();
console.log("หนึ่งเคสต่อหนึ่งปัญหาลูกค้า; ใช้ /new ก่อนลองคนละเคส");
console.log(
  "จำเคสเดิมเมื่อเปิดใหม่ ข้อมูลเก็บใน storage/chat-session.json (หรือ CHAT_STATE_FILE)",
);
console.log(
  "ใช้โมเดลตามค่าของเซิร์ฟเวอร์ อาจมีค่า API; จำลองเฉพาะเครื่องมือ incident ไม่ใช่ปัญหาลูกค้า\n",
);
if (conversation || pending) status();
const terminal = createInterface({
  input: process.stdin,
  output: process.stdout,
});
const prompt = () => {
  if (process.stdin.isTTY)
    process.stdout.write(role === "customer" ? "ลูกค้า> " : "เจ้าหน้าที่> ");
};
terminal.on("SIGINT", () => terminal.close());
prompt();
try {
  for await (const line of terminal) {
    const text = line.trim();
    if (!text) {
      prompt();
      continue;
    }
    if (text === "/exit") break;
    if (text === "/new") {
      if (pending)
        console.log(
          "ยังมีคำขอที่ไม่ทราบผล ใช้ /retry ให้สำเร็จก่อนเริ่มเคสใหม่",
        );
      else {
        conversation = undefined;
        role = "customer";
        save();
        console.log(
          "เริ่มเคสใหม่แล้ว (ประวัติเคสก่อนหน้ายังอยู่ในเซิร์ฟเวอร์)",
        );
      }
    } else if (text === "/operator" || text === "/customer") {
      role = text.slice(1);
      save();
      console.log(
        "เปลี่ยนเป็น " + (role === "customer" ? "ลูกค้า" : "เจ้าหน้าที่"),
      );
    } else if (text === "/status") {
      status();
    } else if (text === "/help") {
      help();
    } else if (text === "/history") {
      if (!conversation) console.log("ยังไม่มีบทสนทนา");
      else {
        try {
          const url = base + "/api/conversations/" + conversation;
          const response = await fetch(url, {
            signal: AbortSignal.timeout(10_000),
          });
          const history = await response.json();
          if (!response.ok)
            console.log(
              "ดูประวัติไม่ได้ (" +
                response.status +
                ")" +
                (response.status === 404
                  ? " หากล้างฐานข้อมูลแล้ว ให้ใช้ /new"
                  : ""),
            );
          else {
            console.log("ประวัติ: " + url);
            const labels = {
              customer: "ลูกค้า",
              operator: "เจ้าหน้าที่",
              assistant: "ผู้ช่วย",
            };
            for (const message of history.messages)
              console.log(
                (labels[message.role] || message.role) + ": " + message.content,
              );
          }
        } catch {
          console.log(
            "อ่านประวัติไม่ได้ ตรวจว่าเปิดเซิร์ฟเวอร์อยู่แล้วลองอีกครั้ง",
          );
        }
      }
    } else if (text.startsWith("/") && text !== "/retry") {
      console.log("ไม่รู้จักคำสั่ง ใช้ /help ดูคำสั่งทั้งหมด");
    } else if (pending && text !== "/retry") {
      console.log(
        "ข้อความนี้ยังไม่ได้ส่ง ใช้ /retry เพื่อรับผลคำขอก่อนหน้าให้เสร็จก่อน",
      );
    } else if (!pending && text === "/retry") {
      console.log("ไม่มีคำขอที่ต้องลองซ้ำ");
    } else if (text !== "/retry" && text.length > 6000) {
      console.log("ข้อความยาวเกิน 6,000 ตัวอักษร กรุณาย่อแล้วส่งใหม่");
    } else {
      if (!pending)
        pending = {
          path: conversation
            ? "/api/conversations/" + conversation + "/messages"
            : "/api/tickets",
          body: conversation
            ? { role, content: text }
            : { customer: {}, messages: [{ role, content: text }] },
          key: randomUUID(),
        };
      // Save before sending so a closed terminal can retry the exact request.
      save();
      const started = performance.now();
      console.log("กำลังวิเคราะห์และเขียนคำตอบ…");
      try {
        const response = await fetch(base + pending.path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": pending.key,
          },
          body: JSON.stringify(pending.body),
          signal: AbortSignal.timeout(60_000),
        });
        const result = await response.json();
        if (!response.ok) {
          console.log(
            "ยังไม่สำเร็จ (" +
              response.status +
              "): " +
              (result.error?.message || "คำขอล้มเหลว"),
          );
          if ([400, 404, 413, 415, 422].includes(response.status)) {
            pending = undefined;
            if (response.status === 404)
              console.log("หากล้างฐานข้อมูลแล้ว ให้ใช้ /new เพื่อเริ่มเคสใหม่");
          } else {
            const retryAfter = response.headers.get("retry-after");
            console.log(
              (retryAfter
                ? "รออย่างน้อย " + retryAfter + " วินาทีแล้ว"
                : "รอสักครู่แล้ว") + "ใช้ /retry เพื่อส่งคำขอเดิมอย่างปลอดภัย",
            );
          }
          save();
        } else {
          conversation = result.conversation_id;
          pending = undefined;
          save();
          console.log("\nผู้ช่วย: " + result.reply + "\n");
          if (result.reply_source === "policy_fallback")
            console.log(
              "ใช้ข้อความมาตรฐานสำหรับส่งให้คนตรวจ เพราะร่างคำตอบ AI ไม่ผ่านตัวตรวจ\n",
            );
          console.log(
            "ความเร่งด่วน: " +
              result.decision.urgency +
              " | ขั้นตอนถัดไป: " +
              (actions[result.decision.action] || result.decision.action) +
              (result.decision.specialist
                ? " (" + result.decision.specialist + ")"
                : ""),
          );
          console.log(
            "Incident: " +
              (result.incident
                ? result.incident.incident_id + " (จำลอง)"
                : "ไม่มี"),
          );
          console.log(
            "ใช้เวลา " +
              ((performance.now() - started) / 1000).toFixed(1) +
              " วินาที | " +
              result.mode +
              " + " +
              result.reply_provider,
          );
          console.log("เคส: " + conversation + " | /new เพื่อเริ่มคนละเคส\n");
        }
      } catch {
        console.log(
          "เชื่อมต่อไม่ได้หรือยังไม่ได้รับผล ตรวจว่าเปิด npm run dev แล้ว จากนั้นใช้ /retry",
        );
      }
    }
    prompt();
  }
} finally {
  terminal.close();
}
if (conversation || pending)
  console.log(
    "บันทึกเคสไว้แล้ว เปิด npm run chat อีกครั้งเพื่อคุยต่อ" +
      (pending ? " แล้วใช้ /retry" : ""),
  );
console.log("ออกจาก Support chat แล้ว ข้อความถัดไปจะเป็นคำสั่งของ terminal");
