export function GET() {
  return Response.json({
    service: "Support Ticket Triage",
    docs: "See README.md",
    endpoints: [
      "POST /api/tickets",
      "POST /api/conversations/{id}/messages",
      "GET /api/conversations/{id}",
    ],
    note: "API-only take-home. Use npm run demo for a sample conversation.",
  });
}
