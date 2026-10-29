// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireAdmin } from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { requireAdminPermission } from "../lib/admin-permissions.ts";
import { DatabaseQueryError, queryAdmin } from "../lib/database.ts";
import handler from "../functions/admin-accounts.ts";

vi.mock("../lib/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth.ts")>();
  return { ...actual, requireAdmin: vi.fn() };
});
vi.mock("../lib/admin-permissions.ts", () => ({ requireAdminPermission: vi.fn() }));
vi.mock("../lib/admin-identity.ts", () => ({ assertActiveAdminActor: vi.fn() }));
vi.mock("../lib/database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/database.ts")>();
  return { ...actual, queryAdmin: vi.fn(), query: vi.fn() };
});

function request(method = "GET", body?: unknown, marker = true): Request {
  return new Request("https://example.test/api/admin/accounts", {
    method,
    headers: {
      Origin: "https://example.test",
      ...(marker ? { "X-IUB-Admin": "1" } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("administrative account API", () => {
  beforeEach(() => {
    vi.mocked(assertActiveAdminActor).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns identities, roles and permissions without credentials", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "admin", actorUserId: 7, expiresAt: 9999999999 });
    vi.mocked(requireAdminPermission).mockResolvedValue(undefined);
    vi.mocked(queryAdmin).mockImplementation(async (sql) => {
      if (sql.includes("admin_list_accounts")) {
        return [{
          user_id: "7", identity_issuer: "local", identity_subject: "admin",
          email: "admin@example.test", is_active: true,
          created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
          roles: [{ roleId: "1", roleKey: "manager", displayName: "Manager", description: null }],
          permissions: ["account.manage"],
        }];
      }
      if (sql.includes("FROM public.role_permissions")) {
        return [{ role_id: "1", permission_key: "account.manage" }];
      }
      if (sql.includes("FROM public.roles")) {
        return [{ id: "1", role_key: "manager", display_name: "Manager", description: null }];
      }
      if (sql.includes("FROM public.permissions")) {
        return [{ permission_key: "account.manage", description: "Gestionar cuentas" }];
      }
      return [];
    });

    const response = await handler(request());
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      currentActorUserId: "7",
      accounts: [{ identitySubject: "admin", permissions: ["account.manage"] }],
      roles: [{ roleKey: "manager", permissions: ["account.manage"] }],
    });
    expect(JSON.stringify(body)).not.toMatch(/password|hash|token|secret/i);
    expect(requireAdminPermission).toHaveBeenCalledWith(7, "account.manage");
  });

  it("creates actors without accepting a password", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "admin", actorUserId: 7, expiresAt: 9999999999 });
    vi.mocked(requireAdminPermission).mockResolvedValue(undefined);
    vi.mocked(queryAdmin).mockResolvedValue([{ user_id: "12" }]);

    const response = await handler(request("POST", {
      action: "create",
      identityIssuer: "local",
      identitySubject: "operator",
      email: "operator@example.test",
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ADMIN_USERS");
    expect(queryAdmin).toHaveBeenCalledWith(
      expect.stringContaining("admin_create_account"),
      [7, "local", "operator", "operator@example.test"],
    );
  });

  it("deactivates and assigns roles through permissioned routines", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "admin", actorUserId: 7, expiresAt: 9999999999 });
    vi.mocked(requireAdminPermission).mockResolvedValue(undefined);
    vi.mocked(queryAdmin)
      .mockResolvedValueOnce([{ admin_set_account_active: null }])
      .mockResolvedValueOnce([{ admin_assign_role: null }]);

    expect((await handler(request("POST", { action: "set_active", userId: 12, active: false }))).status).toBe(200);
    expect((await handler(request("POST", { action: "assign_role", userId: 12, roleId: 3 }))).status).toBe(200);
    expect(queryAdmin).toHaveBeenNthCalledWith(1, expect.stringContaining("admin_set_account_active"), [7, 12, false]);
    expect(queryAdmin).toHaveBeenNthCalledWith(2, expect.stringContaining("admin_assign_role"), [7, 12, 3]);
  });

  it("requires account.manage", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "viewer", actorUserId: 9, expiresAt: 9999999999 });
    vi.mocked(requireAdminPermission).mockRejectedValueOnce(new DatabaseQueryError("42501"));

    const response = await handler(request());
    expect(response.status).toBe(403);
    expect(queryAdmin).not.toHaveBeenCalled();
  });

  it("requires the admin CSRF marker before parsing the body", async () => {
    const response = await handler(request("POST", { action: "create" }, false));
    expect(response.status).toBe(403);
    expect(queryAdmin).not.toHaveBeenCalled();
  });
});
