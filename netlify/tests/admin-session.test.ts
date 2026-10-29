// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, hashPassword } from "../lib/auth.ts";
import { recordLoginFailure, resetLoginRateLimitForTests } from "../lib/login-rate-limit.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { ApiError } from "../lib/http.ts";
import handler from "../functions/admin-session.ts";

vi.mock("../lib/admin-identity.ts", () => ({ assertActiveAdminActor: vi.fn() }));

function request(origin?: string): Request {
  return new Request("https://example.test/api/admin/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify({ username: "admin", password: "correct horse battery staple" }),
  });
}

function sessionRequest(token: string): Request {
  return new Request("https://example.test/api/admin/session", {
    method: "GET",
    headers: { cookie: `iub_admin_session=${encodeURIComponent(token)}` },
  });
}

describe("administrative session origin guard", () => {
  beforeEach(() => {
    resetLoginRateLimitForTests();
  });

  afterEach(() => {
    resetLoginRateLimitForTests();
    vi.unstubAllEnvs();
  });

  it("rejects cross-origin login attempts", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret-with-at-least-32-bytes");
    vi.stubEnv("ADMIN_USERS", JSON.stringify([{
      username: "admin",
      passwordHash: hashPassword("correct horse battery staple"),
      actorUserId: 7,
    }]));

    const response = await handler(request("https://evil.example"));
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("accepts same-origin login and sets the hardened cookie", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret-with-at-least-32-bytes");
    vi.stubEnv("ADMIN_USERS", JSON.stringify([{
      username: "admin",
      passwordHash: hashPassword("correct horse battery staple"),
      actorUserId: 7,
    }]));
    vi.mocked(assertActiveAdminActor).mockResolvedValue(undefined);

    const response = await handler(request("https://example.test"));
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(assertActiveAdminActor).toHaveBeenCalledWith(7);
  });

  it("returns 429 after repeated login failures", async () => {
    vi.stubEnv("LOGIN_RATE_LIMIT_MAX_ATTEMPTS", "2");
    vi.stubEnv("LOGIN_RATE_LIMIT_WINDOW_SECONDS", "60");
    recordLoginFailure("admin", "unknown");
    recordLoginFailure("admin", "unknown");

    const response = await handler(request("https://example.test"));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(await response.text()).toContain("too_many_attempts");
  });

  it("does not issue a session for an inactive actor", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret-with-at-least-32-bytes");
    vi.stubEnv("ADMIN_USERS", JSON.stringify([{
      username: "admin",
      passwordHash: hashPassword("correct horse battery staple"),
      actorUserId: 7,
    }]));
    vi.mocked(assertActiveAdminActor).mockRejectedValueOnce(
      new ApiError(401, "admin_session_invalid", "La sesión administrativa ya no es válida."),
    );

    const response = await handler(request("https://example.test"));
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("invalid_credentials");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("revalidates an existing session and rejects a deactivated actor", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret-with-at-least-32-bytes");
    const token = createSessionToken({
      username: "admin",
      actorUserId: 7,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    vi.mocked(assertActiveAdminActor).mockRejectedValueOnce(
      new ApiError(401, "admin_session_invalid", "La sesión administrativa ya no es válida."),
    );

    const response = await handler(sessionRequest(token));
    expect(response.status).toBe(401);
    expect(assertActiveAdminActor).toHaveBeenCalledWith(7);
  });

  it("accepts an existing session while the actor remains active", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret-with-at-least-32-bytes");
    const token = createSessionToken({
      username: "admin",
      actorUserId: 7,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    vi.mocked(assertActiveAdminActor).mockResolvedValueOnce(undefined);

    const response = await handler(sessionRequest(token));
    expect(response.status).toBe(200);
  });
});
