// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import submitHandler from "../functions/offered-books-submit.ts";
import {
  consumePublicRateLimit,
  enforcePublicRateLimit,
  publicRateLimitResponse,
  resetPublicRateLimitForTests,
} from "../lib/public-rate-limit.ts";

function request(address: string): Request {
  return new Request("https://example.test/api/offered-books", {
    headers: { "x-nf-client-connection-ip": address },
  });
}

describe("public endpoint rate limiting", () => {
  afterEach(() => resetPublicRateLimitForTests());

  it("blocks after the configured number of requests", () => {
    const req = request("203.0.113.20");
    expect(consumePublicRateLimit(req, "draft", 2, 60, 1_000).allowed).toBe(true);
    expect(consumePublicRateLimit(req, "draft", 2, 60, 1_000).allowed).toBe(true);
    const blocked = consumePublicRateLimit(req, "draft", 2, 60, 1_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("isolates buckets by address and scope", () => {
    const first = request("203.0.113.20");
    const second = request("198.51.100.8");
    expect(consumePublicRateLimit(first, "draft", 1, 60, 1_000).allowed).toBe(true);
    expect(consumePublicRateLimit(first, "draft", 1, 60, 1_000).allowed).toBe(false);
    expect(consumePublicRateLimit(second, "draft", 1, 60, 1_000).allowed).toBe(true);
    expect(consumePublicRateLimit(first, "status", 1, 60, 1_000).allowed).toBe(true);
  });

  it("expires the window", () => {
    const req = request("203.0.113.20");
    expect(consumePublicRateLimit(req, "submit", 1, 60, 1_000).allowed).toBe(true);
    expect(consumePublicRateLimit(req, "submit", 1, 60, 1_000).allowed).toBe(false);
    expect(consumePublicRateLimit(req, "submit", 1, 60, 62_000).allowed).toBe(true);
  });

  it("returns a safe 429 response", async () => {
    const response = publicRateLimitResponse({ allowed: false, retryAfterSeconds: 45 });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("45");
    expect(await response.text()).toContain("too_many_requests");
  });

  it("enforce helper returns null below the limit", () => {
    expect(enforcePublicRateLimit(request("203.0.113.20"), "catalog", 2, 60)).toBeNull();
  });

  it("is applied before parsing a public submission body", async () => {
    const makeRequest = () => new Request("https://example.test/api/offered-books/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-nf-client-connection-ip": "203.0.113.40" },
      body: "{}",
    });
    for (let index = 0; index < 10; index += 1) {
      expect((await submitHandler(makeRequest())).status).toBe(400);
    }
    expect((await submitHandler(makeRequest())).status).toBe(429);
  });
});
