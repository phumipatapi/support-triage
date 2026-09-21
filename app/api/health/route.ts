export function GET() {
  return Response.json({
    status: "ok",
    service: "support-triage",
    note: "Liveness only; provider connectivity is not checked.",
  });
}
