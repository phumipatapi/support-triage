import type { AssessmentData, DecisionData } from "./schemas";

export const POLICY_VERSION = "policy-v3";
export function selectKnowledge(
  scores: AssessmentData["faq_scores"],
): string[] {
  return scores
    .filter((f) => f.relevance >= 0.75)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 3)
    .map((f) => f.id);
}
// These are conservative initial thresholds, NOT calibrated accuracy guarantees.
export function decide(a: AssessmentData): DecisionData {
  const knowledge = selectKnowledge(a.faq_scores);
  const incident =
    a.ongoing_outage >= 0.8 &&
    a.multiple_users >= 0.8 &&
    a.core_work_blocked >= 0.8 &&
    a.classification_confidence >= 0.75;
  let urgency = a.urgency;
  let action: DecisionData["action"] = "escalate_to_human";
  let specialist: DecisionData["specialist"] = null;
  const reasons: string[] = [];
  // Strong service-loss evidence with little evidence of multiple affected users
  // is high priority. A free-standing critical label cannot supply missing scope.
  if (
    urgency === "critical" &&
    a.ongoing_outage >= 0.8 &&
    a.core_work_blocked >= 0.8 &&
    a.multiple_users < 0.2
  ) {
    urgency = "high";
    reasons.push(
      "Service access is blocked, but multiple affected users are not established.",
    );
  }
  if (incident) {
    urgency = "critical";
    reasons.push(
      "Ongoing loss of core service reported by multiple users; open a simulated incident for human investigation.",
    );
  } else if (a.financial_risk >= 0.6) {
    if (urgency !== "critical") urgency = "high";
    action = "route_to_specialist";
    specialist = "billing";
    reasons.push(
      "Financial exposure requires billing verification; pending charges are not proof of settled payments. No financial action is authorized.",
    );
  } else if (a.unresolved_bug >= 0.6) {
    if (urgency === "low") urgency = "medium";
    action = "route_to_specialist";
    specialist = "engineering";
    reasons.push(
      "An unresolved bug needs investigation even when the latest message also asks for a feature.",
    );
  } else if (
    a.classification_confidence >= 0.75 &&
    a.knowledge_sufficient >= 0.85 &&
    knowledge.length > 0 &&
    a.ongoing_outage < 0.2 &&
    a.core_work_blocked < 0.2 &&
    (urgency === "low" || urgency === "medium")
  ) {
    action = "auto_respond";
    reasons.push(
      "Relevant FAQ appears sufficient for a low-risk informational answer.",
    );
  } else
    reasons.push(
      "Evidence is incomplete, uncertain, or high-impact; human review is needed.",
    );
  if (a.classification_confidence < 0.75) {
    action = "escalate_to_human";
    specialist = null;
    reasons.push(
      "Classification confidence is below the automation threshold.",
    );
  }
  if (
    a.deadline >= 0.7 &&
    a.core_work_blocked >= 0.7 &&
    urgency !== "critical"
  ) {
    urgency = "high";
    if (action === "auto_respond") action = "escalate_to_human";
    reasons.push("A near-term deadline and blocked work increase urgency.");
  }
  return {
    urgency,
    extracted: {
      product_area: a.product_area,
      issue_type: a.issue_type,
      sentiment: a.sentiment,
      language: a.language,
    },
    action,
    specialist,
    reasons,
    knowledge_ids: knowledge,
    incident_allowed: incident,
    tools_called: ["search_knowledge_base"],
    policy_version: POLICY_VERSION,
  };
}
