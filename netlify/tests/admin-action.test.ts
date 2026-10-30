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

  it("plans an exchange without a manual receipt code and sends the proposed date", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "admin", actorUserId: 7, expiresAt: 9999999999 });
    vi.mocked(queryAdmin).mockResolvedValue([{
      exchange_id: "10",
      reception_id: "20",
      delivery_id: "30",
      scheduled_at: "2026-10-30T17:00:00.000Z",
    }]);
    const planningKey = "11111111-1111-4111-8111-111111111111";

    const response = await handler(createRequest({
      action: "exchange.plan",
      requestId: 42,
      scheduledAt: "2026-10-30T17:00:00.000Z",
      planningKey,
    }));

    expect(response.status).toBe(200);
    expect(queryAdmin).toHaveBeenCalledWith(
      expect.stringContaining("plan_exchange_with_dropoff"),
      [42, "2026-10-30T17:00:00.000Z", planningKey, 7],
    );
    expect(JSON.stringify(vi.mocked(queryAdmin).mock.calls[0]?.[1])).not.toContain("receiptCode");
  });

  it("plans with the database default date when no proposed date is sent", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "admin", actorUserId: 7, expiresAt: 9999999999 });
    vi.mocked(queryAdmin).mockResolvedValue([{
      exchange_id: "10",
      reception_id: "20",
      delivery_id: "30",
      scheduled_at: "2026-10-30T17:00:00.000Z",
    }]);
    const planningKey = "11111111-1111-4111-8111-111111111111";

    const response = await handler(createRequest({
      action: "exchange.plan",
      requestId: 42,
      planningKey,
    }));

    expect(response.status).toBe(200);
    expect(queryAdmin).toHaveBeenCalledWith(
      expect.stringContaining("plan_exchange_with_dropoff"),
      [42, null, planningKey, 7],
    );
  });

  it("normalizes a date-only proposed date to noon in Colombia", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "admin", actorUserId: 7, expiresAt: 9999999999 });
    vi.mocked(queryAdmin).mockResolvedValue([{ exchange_id: "10" }]);
    const planningKey = "11111111-1111-4111-8111-111111111111";

    const response = await handler(createRequest({
      action: "exchange.plan",
      requestId: 42,
      scheduledAt: "2026-10-30",
      planningKey,
    }));

    expect(response.status).toBe(200);
    expect(queryAdmin).toHaveBeenCalledWith(
      expect.stringContaining("plan_exchange_with_dropoff"),
      [42, "2026-10-30T12:00:00-05:00", planningKey, 7],
    );
  });

  it("issues a recoverable lookup token without storing it in plaintext", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "admin", actorUserId: 7, expiresAt: 9999999999 });
    vi.mocked(queryAdmin).mockResolvedValue([{ token_id: "5" }]);

    const response = await handler(createRequest({
      action: "request.issue_lookup_token",
      requestId: 42,
      label: "recuperación",
    }));

    expect(response.status).toBe(200);
    const body = await response.json() as { result: { token: string; token_id: string } };
    expect(body.result.token).toHaveLength(43);
    expect(body.result.token_id).toBe("5");
    expect(queryAdmin).toHaveBeenCalledWith(
      expect.stringContaining("issue_request_lookup_token"),
      [42, expect.any(Buffer), 7, "recuperación"],
    );
    expect(JSON.stringify(vi.mocked(queryAdmin).mock.calls[0]?.[1]?.slice(0, 3))).not.toContain(body.result.token);
  });

  it("approves without a reason and requires one only for rejection", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "admin", actorUserId: 7, expiresAt: 9999999999 });
    vi.mocked(queryAdmin).mockResolvedValue([{ set_request_status: null }]);

    const approved = await handler(createRequest({ action: "request.approve", requestId: 42 }));
    expect(approved.status).toBe(200);
    expect(queryAdmin).toHaveBeenCalledWith(
      expect.stringContaining("set_request_status"),
      [42, 7, null],
    );

    vi.mocked(queryAdmin).mockClear();
    const missing = await handler(createRequest({ action: "request.reject", requestId: 42 }));
    expect(missing.status).toBe(400);
    expect(queryAdmin).not.toHaveBeenCalled();

    const rejected = await handler(createRequest({ action: "request.reject", requestId: 42, reason: "Documentación incompleta" }));
    expect(rejected.status).toBe(200);
    expect(queryAdmin).toHaveBeenCalledWith(
      expect.stringContaining("set_request_status"),
      [42, 7, "Documentación incompleta"],
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
