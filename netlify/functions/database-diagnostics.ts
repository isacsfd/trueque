import { timingSafeEqual } from "node:crypto";
import { pingDatabase } from "../lib/database.ts";

const responseHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  Vary: "Authorization",
};

function jsonResponse(status: number, body: Record<string, boolean | string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

function hasValidBearerToken(request: Request, expectedToken: string): boolean {
  const authorization = request.headers.get("authorization");
  const prefix = "Bearer ";

  if (!authorization?.startsWith(prefix)) {
    return false;
  }

  const supplied = Buffer.from(authorization.slice(prefix.length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");

  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export default async function handler(request: Request): Promise<Response> {
  const expectedToken = process.env.DATABASE_DIAGNOSTICS_TOKEN;

  // Fail closed when no strong token is configured; do not expose the route.
  if (!expectedToken || Buffer.byteLength(expectedToken, "utf8") < 32) {
    return jsonResponse(404, { error: "not_found" });
  }

  if (!hasValidBearerToken(request, expectedToken)) {
    return jsonResponse(404, { error: "not_found" });
  }

  if (request.method !== "GET") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  try {
    await pingDatabase();
    return jsonResponse(200, { ok: true });
  } catch {
    return jsonResponse(503, { ok: false, error: "database_unavailable" });
  }
}

export const config = {
  path: "/api/private/database-diagnostics",
};
