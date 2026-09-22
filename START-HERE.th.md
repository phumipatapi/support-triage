# เริ่มใช้งาน

โปรเจกต์นี้เป็น API ไม่มีหน้าแชต ตามขอบเขตโจทย์ ใช้ Next.js + TypeScript + SQLite

## ลองโดยไม่เสียค่า API

เปิด terminal ในโฟลเดอร์โปรเจกต์ แล้วรัน:

```sh
npm run setup
```

เปิด terminal อีกหน้าที่โฟลเดอร์เดียวกัน:

```sh
npm run demo
```

จะทดลองแจ้งระบบล่มภาษาไทย ส่งคำขอเดิมซ้ำ และถามต่ออีกหนึ่งข้อความ ผลที่ขึ้นว่า `OFFLINE MOCK` เป็นข้อมูลจำลองสำหรับทดสอบระบบ **ยังไม่ได้เรียก Jev หรือ GPT**

## เปิดใช้ Jev + GPT จริง

แก้ไฟล์ `.env.local` ที่คำสั่ง setup สร้างให้:

```dotenv
DECISION_PROVIDER=jev
REPLY_PROVIDER=openai
TYPESAFE_API_KEY=ใส่คีย์ของคุณ
OPENAI_API_KEY=ใส่คีย์ของคุณ
```

หยุด server ด้วย Ctrl+C แล้วรัน `npm run dev` ใหม่ จากนั้นใช้ `npm run demo` ได้เหมือนเดิม การใช้โหมดนี้จะมีค่า API ตามผู้ให้บริการ

ถ้าจะให้ผู้ตรวจรันด้วย OpenAI key อย่างเดียว เปลี่ยน `DECISION_PROVIDER=openai` และคง `REPLY_PROVIDER=openai`

## ใช้ GLM แทน GPT สำหรับข้อความตอบ

สำหรับคีย์ Z.AI API ปกติ ตั้งค่าใน `.env.local` ดังนี้:

```dotenv
DECISION_PROVIDER=jev
REPLY_PROVIDER=glm
TYPESAFE_API_KEY=คีย์ Jev เดิมของคุณ
GLM_API_KEY=คีย์ Z.AI ของคุณ
GLM_MODEL=glm-4.7
```

โหมดนี้ไม่ต้องใช้ OpenAI key หยุดแล้วเปิด server ใหม่ด้วย `npm run dev` เพื่อให้โหลดค่าใหม่ Jev ยังวิเคราะห์ ticket เหมือนเดิม ส่วน GLM เขียนข้อความตอบ การทดสอบจริงใช้ `npm run eval -- --live` และมีค่า API ตามผู้ให้บริการ

เมื่อส่ง take-home ให้กลับมาใช้ GPT (`REPLY_PROVIDER=openai`) เพราะโจทย์ระบุให้ใช้โมเดล OpenAI

## ดูโค้ดตรงไหนก่อน

1. `lib/triage.ts` — flow ตั้งแต่รับข้อความจนตอบ
2. `lib/models.ts` — ส่ง ticket และ FAQ ทั้งชุดให้ Jev ครั้งเดียว พร้อม adapter ของ GPT
3. `lib/policy.ts` — กฎเลือก action และขอบเขตสิทธิ์
4. `lib/tools.ts` — tool contracts และเปิด incident จำลองแบบไม่ซ้ำ
5. `lib/db.ts` — เก็บประวัติ ผลตัดสินใจ และสถานะ retry

FAQ อยู่ใน `data/faq.json` ไม่ใช้ embeddings หรือ vector database ส่วน GPT เรียบเรียงข้อความจากผลที่ระบบได้จริง ไม่ได้รับสิทธิ์เรียกเครื่องมือเอง

## ตรวจงาน

```sh
npm run check
npm run smoke
npm run eval
```

สามคำสั่งนี้ไม่เรียกโมเดลจริง ส่วน `npm run eval -- --live` ใช้โหมดจริงที่ตั้งไว้และมีค่า API

รายละเอียด API และตัวอย่างคำขออยู่ใน `README.md` คำอธิบายสถาปัตยกรรมสำหรับส่งงานอยู่ใน `WRITEUP.md` และสถานะการตรวจงานอยู่ใน `VALIDATION.md`
