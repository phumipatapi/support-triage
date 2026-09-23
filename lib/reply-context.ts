import type { ReplyInput } from "./models";
import { AppError } from "./errors";
import type { State } from "./schemas";

export function humanEvidence(state: State): State {
  return {
    ...state,
    messages: state.messages.filter((m) => m.role !== "assistant"),
  };
}

// Only human messages determine response language. English/Thai is the supported
// deterministic boundary; other scripts defer to the model, not a Latin=English guess.
export function replyLanguage(input: ReplyInput): "en" | "th" | "other" {
  const humans = input.state.messages.filter((m) => m.role !== "assistant");
  const current = humans.at(-1);
  for (const message of [...humans]
    .reverse()
    .filter((m) => m.role === current?.role)) {
    if (/[\u0E00-\u0E7F]/u.test(message.content)) return "th";
    const letters = message.content.match(/\p{L}/gu) || [];
    if (letters.length && letters.every((c) => /[A-Za-z]/.test(c))) return "en";
    if (letters.length) return "other";
  }
  return "other";
}

export function replyContext(input: ReplyInput) {
  return {
    ...input,
    // Previous generated prose may contain false actions or the wrong language.
    // Use persisted human evidence + actual current outcomes instead of repeating it.
    state: humanEvidence(input.state),
    latest_request: input.state.messages
      .filter((m) => m.role !== "assistant")
      .at(-1),
    response_language: replyLanguage(input),
    response_audience: input.state.messages
      .filter((m) => m.role !== "assistant")
      .at(-1)?.role,
    decision: { ...input.decision, reasons: undefined },
    execution_facts: {
      team_contacted: false,
      payment_records_verified: false,
      refund_issued: false,
      account_changed: false,
      incident_result: input.incident,
    },
  };
}

// A narrow regression guard, not a semantic truth verifier. Reject visibly wrong
// language and common unsupported action claims; never silently publish those drafts.
export function validateReply(text: string, input: ReplyInput) {
  const language = replyLanguage(input);
  const thai = /[\u0E00-\u0E7F]/u.test(text);
  if ((language === "en" && thai) || (language === "th" && !thai)) {
    throw new AppError(
      503,
      "reply_language_mismatch",
      "Reply language was incorrect. Retry the same request key.",
    );
  }
  const actionClaim =
    /\b(?:we|i)(?:['’](?:ll|ve|re)|\s+(?:will|have|are|am))\s+(?:(?:already|now|currently|actively|working\s+to)\s+)*(?:rout\w*|escalat\w*|forward\w*|notif\w*|investigat\w*|resolv\w*|refund\w*|contact\w*)/i;
  const thaiClaim =
    /(?:เรา|ทีมงาน|ทางเรา)(?:กำลัง|ได้|จะ)(?:นำเรื่อง|ส่งเรื่อง|ส่งต่อ|ประสาน|ตรวจสอบ|แก้ไข|คืนเงิน)/u;
  if (actionClaim.test(text) || thaiClaim.test(text)) {
    throw new AppError(
      503,
      "unsupported_reply_claim",
      "Reply claimed an unperformed action. Retry the same request key.",
    );
  }
  // Support triage has no authority to advise delaying a customer's bank dispute.
  // This catches common imperative forms, not all financial advice or paraphrases.
  const disputeDelay =
    /\b(?:avoid|delay|postpone|hold off (?:on )?|do not|don't|wait before)\s+(?:\w+\s+){0,6}(?:disput\w*|chargebacks?)\b/i;
  const thaiDisputeDelay =
    /(?:อย่า|ยังไม่ควร|ชะลอ|เลื่อน)(?:การ)?(?:โต้แย้ง|ปฏิเสธ|คัดค้าน)(?:ยอด|รายการ|ธุรกรรม)/u;
  if (disputeDelay.test(text) || thaiDisputeDelay.test(text)) {
    throw new AppError(
      503,
      "unsupported_financial_advice",
      "Reply included unsupported financial advice. Retry the same request key.",
    );
  }
}

// A rejected draft must not prevent delivery of an already-approved human handoff.
// This template describes only policy and execution facts; it is not an FAQ answer.
export function finalizeReply(
  draft: { reply: string; citation_ids: string[] },
  input: ReplyInput,
) {
  try {
    validateReply(draft.reply, input);
    return { ...draft, validation: { reply_source: "model" } };
  } catch (error) {
    const language = replyLanguage(input);
    if (
      !(error instanceof AppError) ||
      ![
        "reply_language_mismatch",
        "unsupported_reply_claim",
        "unsupported_financial_advice",
      ].includes(error.code) ||
      input.decision.action === "auto_respond" ||
      language === "other"
    )
      throw error;
    const specialist = input.decision.specialist;
    const financial = input.decision.extracted.product_area === "billing";
    const recommendation =
      language === "th"
        ? specialist === "billing"
          ? "แนะนำให้ผู้เชี่ยวชาญด้านการชำระเงินตรวจสอบเคสนี้"
          : specialist === "engineering"
            ? "แนะนำให้ฝ่ายวิศวกรรมตรวจสอบเคสนี้"
            : "แนะนำให้เจ้าหน้าที่ตรวจสอบเคสนี้"
        : specialist === "billing"
          ? "I recommend a billing specialist review this case."
          : specialist === "engineering"
            ? "I recommend an engineering specialist review this case."
            : "I recommend a human support operator review this case.";
    const parts =
      language === "th"
        ? [
            recommendation,
            "คำตอบโดยละเอียดต้องให้เจ้าหน้าที่ตรวจสอบ บริการนี้ยังไม่ได้ติดต่อทีมใด",
            ...(financial
              ? [
                  "ยังไม่ได้ตรวจสอบข้อมูลการชำระเงินหรือสิทธิ์บัญชี และไม่ได้ดำเนินการคืนเงินหรือแก้ไขบัญชี",
                ]
              : []),
            ...(input.incident
              ? ["มีบันทึก incident จำลองสำหรับการตรวจสอบโดยเจ้าหน้าที่แล้ว"]
              : []),
          ]
        : [
            recommendation,
            "A detailed answer needs human review. This service has not contacted any team.",
            ...(financial
              ? [
                  "Payment and account records have not been verified; no refund or account change has been performed.",
                ]
              : []),
            ...(input.incident
              ? ["A simulated incident has been recorded for human review."]
              : []),
          ];
    return {
      reply: parts.join(" "),
      citation_ids: [],
      validation: {
        reply_source: "policy_fallback",
        rejected_draft_code: error.code,
      },
    };
  }
}
