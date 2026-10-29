// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { pingDatabase } from "../lib/database.ts";
import handler from "../functions/database-diagnostics.ts";

vi.mock("../lib/database.ts", () => ({
  pingDatabase: vi.fn(),
}));

const testToken = "test-only-diagnostic-token-with-more-than-32-bytes";

function createRequest(authorization?: string, method = "GET"): Request {
  return new Request("https://example.test/api/private/database-diagnostics", {
    method,
    headers: authorization ? { authorization } : undefined,
  });
}

describe("private database diagnostics", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("fails closed when the diagnostic token is not configured", async () => {
    vi.stubEnv("DATABASE_DIAGNOSTICS_TOKEN", "");

    const response = await handler(createRequest(`Bearer ${testToken}`));

    expect(response.status).toBe(404);
    expect(pingDatabase).not.toHaveBeenCalled();
  });

  it("does not run a database query for an invalid token", async () => {
    vi.stubEnv("DATABASE_DIAGNOSTICS_TOKEN", testToken);

    const response = await handler(createRequest("Bearer invalid-token"));

    expect(response.status).toBe(404);
    expect(pingDatabase).not.toHaveBeenCalled();
  });

  it("fails closed for a weak configured token", async () => {
    vi.stubEnv("DATABASE_DIAGNOSTICS_TOKEN", "too-short");

    const response = await handler(createRequest("Bearer too-short"));

    expect(response.status).toBe(404);
    expect(pingDatabase).not.toHaveBeenCalled();
  });

  it("returns only a generic success result for an authorized request", async () => {
    vi.stubEnv("DATABASE_DIAGNOSTICS_TOKEN", testToken);
    vi.mocked(pingDatabase).mockResolvedValue(undefined);

    const response = await handler(createRequest(`Bearer ${testToken}`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(pingDatabase).toHaveBeenCalledOnce();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("suppresses database errors in the HTTP response", async () => {
    vi.stubEnv("DATABASE_DIAGNOSTICS_TOKEN", testToken);
    vi.mocked(pingDatabase).mockRejectedValue(
      new Error("sensitive connection details must not be returned"),
    );

    const response = await handler(createRequest(`Bearer ${testToken}`));
    const responseText = await response.text();

    expect(response.status).toBe(503);
    expect(responseText).toBe(
      JSON.stringify({ ok: false, error: "database_unavailable" }),
    );
    expect(responseText).not.toContain("sensitive");
  });
});
