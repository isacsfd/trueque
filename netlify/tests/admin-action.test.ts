// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireAdmin } from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { DatabaseQueryError, queryAdmin } from "../lib/database.ts";
import handler from "../functions/admin-action.ts";

vi.mock("../lib/auth.ts", () => ({ requireAdmin: vi.fn() }));
vi.mock("../lib/admin-identity.ts", () => ({ assertActiveAdminActor: vi.fn() }));
vi.mock("../lib/database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/database.ts")>();
  return { ...actual, queryAdmin: vi.fn(), query: vi.fn() };
});

function createRequest(body: unknown, marker = true): Request {
  return new Request("https://example.test/api/admin/action", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(marker ? { "X-IUB-Admin": "1" } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("admin action API", () => {
  beforeEach(() => {
    vi.mocked(assertActiveAdminActor).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("delegates an allowed action with the session actor", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "admin", actorUserId: 7, expiresAt: 9999999999 });
    vi.mocked(queryAdmin).mockResolvedValue([{ set_request_status: null }]);

    const response = await handler(createRequest({ action: "request.review", requestId: 42 }));
    expect(response.status).toBe(200);
    expect(queryAdmin).toHaveBeenCalledWith(
      expect.stringContaining("set_request_status"),
      [42, 7, null],
    );
  });

  it("requires a recorded reason for approval and rejection", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "admin", actorUserId: 7, expiresAt: 9999999999 });

    const missing = await handler(createRequest({ action: "request.approve", requestId: 42 }));
    expect(missing.status).toBe(400);
    expect(queryAdmin).not.toHaveBeenCalled();

    vi.mocked(queryAdmin).mockResolvedValue([{ set_request_status: null }]);
    const approved = await handler(createRequest({ action: "request.approve", requestId: 42, reason: "Documentación revisada" }));
    expect(approved.status).toBe(200);
    expect(queryAdmin).toHaveBeenCalledWith(
      expect.stringContaining("set_request_status"),
      [42, 7, "Documentación revisada"],
    );
  });

  it("delegates a photographic review with the session actor", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "admin", actorUserId: 7, expiresAt: 9999999999 });
    vi.mocked(queryAdmin).mockResolvedValue([{ submission_id: "4", status: "in_review" }]);

    const response = await handler(createRequest({
      action: "submission.review",
      submissionId: 4,
      reviewAction: "preapprove",
      reason: "fotografías suficientes",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    }));
    expect(response.status).toBe(200);
    expect(queryAdmin).toHaveBeenCalledWith(
      expect.stringContaining("review_offered_book_submission"),
      [4, 7, "preapprove", "fotografías suficientes", null, "11111111-1111-4111-8111-111111111111"],
    );
  });

  it("rejects unknown actions and missing CSRF markers before touching the database", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "admin", actorUserId: 7, expiresAt: 9999999999 });
    const unknown = await handler(createRequest({ action: "sql.execute" }));
    expect(unknown.status).toBe(400);
    const noMarker = await handler(createRequest({ action: "request.review", requestId: 1 }, false));
    expect(noMarker.status).toBe(403);
    expect(queryAdmin).not.toHaveBeenCalled();
  });

  it("does not expose PostgreSQL messages when a transition is invalid", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "admin", actorUserId: 7, expiresAt: 9999999999 });
    vi.mocked(queryAdmin).mockRejectedValueOnce(new DatabaseQueryError("23514"));
    const response = await handler(createRequest({ action: "exchange.cancel", exchangeId: 9, cancellationKey: "11111111-1111-4111-8111-111111111111" }));
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("SQL");
  });
});
