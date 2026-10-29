// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkLoginRateLimit,
  clearLoginFailures,
  clientAddress,
  recordLoginFailure,
  resetLoginRateLimitForTests,
} from "../lib/login-rate-limit.ts";

describe("best-effort login rate limiting", () => {
  beforeEach(() => {
    resetLoginRateLimitForTests();
    vi.stubEnv("LOGIN_RATE_LIMIT_MAX_ATTEMPTS", "3");
    vi.stubEnv("LOGIN_RATE_LIMIT_IP_MAX_ATTEMPTS", "5");
    vi.stubEnv("LOGIN_RATE_LIMIT_WINDOW_SECONDS", "60");
  });

  afterEach(() => {
    resetLoginRateLimitForTests();
    vi.unstubAllEnvs();
  });

  it("allows attempts below the identity threshold", () => {
    expect(checkLoginRateLimit("admin", "203.0.113.10", 1_000).allowed).toBe(true);
    recordLoginFailure("admin", "203.0.113.10", 1_000);
    recordLoginFailure("admin", "203.0.113.10", 1_000);
    expect(checkLoginRateLimit("admin", "203.0.113.10", 1_000).allowed).toBe(true);
  });

  it("blocks a burst and reports a retry window", () => {
    for (let index = 0; index < 3; index += 1) {
      recordLoginFailure("admin", "203.0.113.10", 1_000);
    }
    const decision = checkLoginRateLimit("admin", "203.0.113.10", 1_000);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("clears the identity bucket after a successful login", () => {
    for (let index = 0; index < 3; index += 1) {
      recordLoginFailure("admin", "203.0.113.10", 1_000);
    }
    clearLoginFailures("admin", "203.0.113.10");
    expect(checkLoginRateLimit("admin", "203.0.113.10", 1_000).allowed).toBe(true);
  });

  it("expires old windows", () => {
    for (let index = 0; index < 3; index += 1) {
      recordLoginFailure("admin", "203.0.113.10", 1_000);
    }
    expect(checkLoginRateLimit("admin", "203.0.113.10", 1_000).allowed).toBe(false);
    expect(checkLoginRateLimit("admin", "203.0.113.10", 62_000).allowed).toBe(true);
  });

  it("uses the Netlify client address before forwarded headers", () => {
    const request = new Request("https://example.test/api/admin/session", {
      headers: {
        "x-nf-client-connection-ip": "198.51.100.7",
        "x-forwarded-for": "203.0.113.99, 10.0.0.1",
      },
    });
    expect(clientAddress(request)).toBe("198.51.100.7");
  });

  it("survives a burst larger than the address threshold", () => {
    for (let index = 0; index < 100; index += 1) {
      recordLoginFailure(`user-${index}`, "203.0.113.10", 1_000);
    }
    expect(checkLoginRateLimit("another-user", "203.0.113.10", 1_000).allowed).toBe(false);
  });
});
