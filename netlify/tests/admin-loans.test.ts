// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireAdmin } from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { DatabaseQueryError, queryAdmin } from "../lib/database.ts";
import handler from "../functions/admin-loans.ts";

vi.mock("../lib/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth.ts")>();
  return { ...actual, requireAdmin: vi.fn() };
});
vi.mock("../lib/admin-identity.ts", () => ({ assertActiveAdminActor: vi.fn() }));
vi.mock("../lib/database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/database.ts")>();
  return { ...actual, queryAdmin: vi.fn(), query: vi.fn() };
});

function request(path = "/api/admin/loans"): Request {
  return new Request(`https://example.test${path}`);
}

describe("administrative loan history", () => {
  beforeEach(() => {
    vi.mocked(requireAdmin).mockReturnValue({
      username: "viewer",
      actorUserId: 9,
      expiresAt: 9999999999,
      sessionVersion: 1,
    } as ReturnType<typeof requireAdmin>);
    vi.mocked(assertActiveAdminActor).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the paginated loan history without personal data", async () => {
    vi.mocked(queryAdmin)
      .mockResolvedValueOnce([{ allowed: true }])
      .mockResolvedValueOnce([{
        loan_id: "8",
        request_id: "3",
        request_code: "IUB-2026-LOAN",
        reservation_id: "5",
        exchange_id: null,
        copy_id: "12",
        inventory_code: "INV-001",
        title: "Libro prestado",
        author: "Autora",
        status: "lent",
        started_at: "2026-11-01T10:00:00Z",
        due_at: "2026-11-03T10:00:00Z",
        closed_at: null,
        dropoff_delivery_id: "20",
        handover_delivery_id: "21",
        return_delivery_id: null,
      }])
      .mockResolvedValueOnce([{ total: 1 }]);

    const response = await handler(request("/api/admin/loans?status=lent&page=2&pageSize=25"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      items: [{
        loanId: "8",
        requestId: "3",
        requestCode: "IUB-2026-LOAN",
        reservationId: "5",
        exchangeId: null,
        copyId: "12",
        inventoryCode: "INV-001",
        title: "Libro prestado",
        author: "Autora",
        status: "lent",
        startedAt: "2026-11-01T10:00:00Z",
        dueAt: "2026-11-03T10:00:00Z",
        closedAt: null,
        deliveries: {
          dropoffDeliveryId: "20",
          handoverDeliveryId: "21",
          returnDeliveryId: null,
        },
      }],
      pagination: { page: 2, pageSize: 25, total: 1, hasMore: false },
    });
    expect(JSON.stringify(body)).not.toContain("participant");
  });

  it("rejects invalid states and unauthorized actors", async () => {
    const invalid = await handler(request("/api/admin/loans?status=nope"));
    expect(invalid.status).toBe(400);

    vi.mocked(queryAdmin).mockResolvedValueOnce([{ allowed: false }]);
    const forbidden = await handler(request());
    expect(forbidden.status).toBe(403);

    vi.mocked(queryAdmin).mockRejectedValueOnce(new DatabaseQueryError("42501"));
    const denied = await handler(request());
    expect(denied.status).toBe(403);
  });
});
