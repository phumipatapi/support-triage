import { z } from "zod";
import { AppError } from "./errors";
import { makeRequestId, type TriageService } from "./triage";
import { service } from "./runtime";

async function readBody(request: Request) {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new AppError(
      415,
      "unsupported_media_type",
      "Use Content-Type: application/json.",
    );
  const reader = request.body?.getReader();
  if (!reader)
    throw new AppError(400, "invalid_json", "Request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 128 * 1024) {
      await reader.cancel();
      throw new AppError(413, "body_too_large", "Request exceeds 128 KiB.");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError(400, "invalid_json", "Request body is not valid JSON.");
  }
}
export async function handle(
  request: Request,
  id?: string,
  getService: () => TriageService = service,
) {
  const requestId = makeRequestId();
  const headers = { "X-Request-Id": requestId, "Cache-Control": "no-store" };
  try {
    if (request.method === "GET") {
      z.string().uuid().parse(id);
      return Response.json(getService().store.history(id!), { headers });
    }
    const body = await readBody(request);
    const result = await getService().submit(
      body,
      request.headers.get("idempotency-key"),
      id,
    );
    console.log(
      JSON.stringify({
        event: "http.completed",
        request_id: requestId,
        run_id: result.body.run_id,
        status: result.status,
        replay: result.replay,
      }),
    );
    return Response.json(result.body, {
      status: result.status,
      headers: { ...headers, "Idempotency-Replayed": String(result.replay) },
    });
  } catch (error) {
    const e =
      error instanceof AppError
        ? error
        : error instanceof z.ZodError
          ? new AppError(422, "validation_error", "Invalid request fields.", {
              issues: error.issues.map((i) => ({
                path: i.path,
                message: i.message,
              })),
            })
          : new AppError(
              500,
              "configuration_or_internal_error",
              "Service unavailable. Check server configuration.",
            );
    console.log(
      JSON.stringify({
        event: "http.error",
        request_id: requestId,
        status: e.status,
        code: e.code,
        ...e.details,
      }),
    );
    return Response.json(
      {
        error: {
          code: e.code,
          message: e.message,
          request_id: requestId,
          details: e.details,
        },
      },
      { status: e.status, headers },
    );
  }
}
