// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireAdmin } from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { queryAdmin } from "../lib/database.ts";
import handler from "../functions/admin-workbench-detail.ts";

vi.mock("../lib/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth.ts")>();
  return { ...actual, requireAdmin: vi.fn() };
});
vi.mock("../lib/admin-identity.ts", () => ({ assertActiveAdminActor: vi.fn() }));
vi.mock("../lib/database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/database.ts")>();
  return { ...actual, queryAdmin: vi.fn(), query: vi.fn() };
});

function request(path: string): Request {
  return new Request(`https://example.test${path}`);
}

describe("administrative workbench detail", () => {
  beforeEach(() => {
    vi.mocked(assertActiveAdminActor).mockResolvedValue(undefined);
    vi.mocked(requireAdmin).mockReturnValue({
      username: "manager",
      actorUserId: 7,
      expiresAt: 9999999999,
      sessionVersion: 1,
    } as ReturnType<typeof requireAdmin>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns history, deliveries and evidence only for the requested request", async () => {
    vi.mocked(queryAdmin).mockImplementation(async (sql) => {
      if (sql.includes("AS allowed")) return [{ allowed: true }];
      if (sql.includes("to_regclass")) return [{ has_submissions: true }];
      if (sql.includes("FROM public.exchange_requests r")) {
        return [{
          request_id: "42",
          history: [{ newStatus: "under_review" }],
          deliveries: [{ id: "3", type: "offered_book_dropoff" }],
          evidence: [{ id: "8", slot: "cover" }],
        }];
      }
      return [];
    });

    const response = await handler(request("/api/admin/workbench/detail?requestId=42"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      requestId: "42",
      history: [{ newStatus: "under_review" }],
      deliveries: [{ id: "3", type: "offered_book_dropoff" }],
      evidence: [{ id: "8", slot: "cover" }],
    });
  });

  it("rejects invalid ids and unauthorized actors", async () => {
    vi.mocked(queryAdmin).mockResolvedValueOnce([{ allowed: false }]);
    const forbidden = await handler(request("/api/admin/workbench/detail?requestId=42"));
    expect(forbidden.status).toBe(403);

    vi.mocked(queryAdmin).mockResolvedValueOnce([{ allowed: true }]);
    const invalid = await handler(request("/api/admin/workbench/detail?requestId=0"));
    expect(invalid.status).toBe(400);
  });

  it("returns 404 when the request does not exist", async () => {
    vi.mocked(queryAdmin).mockImplementation(async (sql) => {
      if (sql.includes("AS allowed")) return [{ allowed: true }];
      if (sql.includes("to_regclass")) return [{ has_submissions: false }];
      return [];
    });
    const response = await handler(request("/api/admin/workbench/detail?requestId=999"));
    expect(response.status).toBe(404);
  });
});
