// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireAdmin } from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { requireAdminPermission } from "../lib/admin-permissions.ts";
import { queryAdmin } from "../lib/database.ts";
import { ApiError } from "../lib/http.ts";
import statsHandler from "../functions/admin-stats.ts";
import accountHandler from "../functions/admin-account.ts";

vi.mock("../lib/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth.ts")>();
  return { ...actual, requireAdmin: vi.fn() };
});
vi.mock("../lib/admin-permissions.ts", () => ({ requireAdminPermission: vi.fn() }));
vi.mock("../lib/admin-identity.ts", () => ({ assertActiveAdminActor: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/database.ts")>();
  return { ...actual, queryAdmin: vi.fn(), query: vi.fn() };
});

function request(path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://example.test${path}`, {
    method,
    headers: {
      Origin: "https://example.test",
      "X-IUB-Admin": "1",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("admin statistics and account", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns real aggregate groups without inventing metrics", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "admin", actorUserId: 7, expiresAt: 9999999999 });
    vi.mocked(requireAdminPermission).mockResolvedValue(undefined);
    vi.mocked(queryAdmin).mockImplementation(async (sql) => {
      if (sql.includes("FROM public.copies")) {
        return [{ total_copies: "12", institutional_total: "10", available: "2", unavailable: "8", reserved: "0", maintenance: "0", retired: "0", verified: "1", unverified: "9", unassessed: "9" }];
      }
      if (sql.includes("FROM public.available_catalog")) return [{ count: 2 }];
      if (sql.includes("FROM public.exchange_requests") && sql.includes("GROUP BY status")) return [{ key: "pending", count: 4 }];
      if (sql.includes("FROM public.offered_book_submissions")) return [{ key: "pending_review", count: 1 }];
      if (sql.includes("FROM public.receptions")) return [{ key: "awaiting_delivery", count: 1 }];
      if (sql.includes("FROM public.book_evaluations")) return [{ key: "accepted", count: 1 }];
      if (sql.includes("FROM public.inventory_admissions")) return [{ key: "admitted", count: 1 }];
      if (sql.includes("FROM public.exchanges") && sql.includes("GROUP BY status")) return [{ key: "completed", count: 3 }];
      if (sql.includes("FROM public.inventory_batches") && !sql.includes("to_char(")) return [{ total: "2", prevalidated: "1", confirmed: "1", cancelled: "0", processed_rows: "20", inserted_rows: "10", reused_rows: "2", rejected_rows: "1", duplicate_rows: "0" }];
      if (sql.includes("FROM public.inventory_import_batches")) return [{ batches: 1, processed_rows: 137, rejected_rows: 0 }];
      return [];
    });

    const response = await statsHandler(request("/api/admin/stats"));
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      range: { months: 6 },
      inventory: {
        totalCopies: 12, institutionalTotal: 10, available: 2, unavailable: 8,
        verified: 1, unverified: 9, publicCatalog: 2,
      },
      requests: { pending: 4 },
      submissions: { pending_review: 1 },
      offersInReview: 1,
      exchanges: { completed: 3 },
      batches: { total: 2, confirmed: 1 },
    });
    expect(requireAdminPermission).toHaveBeenCalledWith(7, "stats.read");
  });

  it("rejects an invalid trend range before running queries", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "admin", actorUserId: 7, expiresAt: 9999999999 });
    vi.mocked(requireAdminPermission).mockResolvedValue(undefined);

    const response = await statsHandler(request("/api/admin/stats?months=0"));
    expect(response.status).toBe(400);
    expect(queryAdmin).not.toHaveBeenCalled();
  });

  it("does not expose account data to an inactive actor", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "inactive", actorUserId: 9, expiresAt: 9999999999 });
    vi.mocked(assertActiveAdminActor).mockRejectedValueOnce(
      new ApiError(401, "admin_session_invalid", "La sesión administrativa ya no es válida."),
    );

    const response = await accountHandler(request("/api/admin/account"));
    expect(response.status).toBe(401);
  });

  it("keeps password changes external and never stores a password", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "admin", actorUserId: 7, expiresAt: 9999999999 });

    const account = await accountHandler(request("/api/admin/account"));
    const accountBody = await account.json() as Record<string, unknown>;
    expect(account.status).toBe(200);
    expect(accountBody).toMatchObject({ canChangePassword: false, passwordManagedBy: "environment" });

    const change = await accountHandler(request("/api/admin/account", "POST", {}));
    expect(change.status).toBe(409);
    expect(await change.text()).toContain("password_managed_externally");
    expect(queryAdmin).not.toHaveBeenCalled();
  });
});
