import express, {
  type Request as ExpressRequest,
  type Response as ExpressResponse,
} from "express";
import { Readable } from "node:stream";
import { handle } from "./lib/http";

const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Keep the bounded streaming JSON parser and error contract shared with unit tests.
async function dispatch(req: ExpressRequest, res: ExpressResponse) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined)
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  const response = await handle(
    new Request("http://localhost" + req.originalUrl, init),
    req.params.id as string | undefined,
  );
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.status(response.status).send(Buffer.from(await response.arrayBuffer()));
}

app.get("/", (_req, res) =>
  res.json({
    service: "Support Ticket Triage",
    docs: "See README.md",
    endpoints: [
      "POST /api/tickets",
      "POST /api/conversations/{id}/messages",
      "GET /api/conversations/{id}",
    ],
    note: "API-only. Use npm run demo for a sample conversation.",
  }),
);
app.get("/api/health", (_req, res) =>
  res.json({
    status: "ok",
    service: "support-triage",
    note: "Liveness only; provider connectivity is not checked.",
  }),
);
app.post("/api/tickets", dispatch);
app.post("/api/conversations/:id/messages", dispatch);
app.get("/api/conversations/:id", dispatch);
app.use((_req, res) => {
  res
    .status(404)
    .json({ error: { code: "not_found", message: "Endpoint not found." } });
});
app.use(
  (
    _error: unknown,
    _req: ExpressRequest,
    res: ExpressResponse,
    _next: express.NextFunction,
  ) => {
    res
      .status(500)
      .json({
        error: { code: "internal_error", message: "Service unavailable." },
      });
  },
);

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
const server = app.listen(port, "127.0.0.1", (error) => {
  if (error) {
    console.error("Server startup failed:", error.message);
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify({
      event: "server.started",
      url: `http://127.0.0.1:${port}`,
    }),
  );
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 25_000).unref();
  });
}
