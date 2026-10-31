// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireAdmin } from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { DatabaseQueryError, queryAdmin } from "../lib/database.ts";
import handler from "../functions/admin-inventory.ts";

vi.mock("../lib/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth.ts")>();
  return { ...actual, requireAdmin: vi.fn() };
});
vi.mock("../lib/admin-identity.ts", () => ({ assertActiveAdminActor: vi.fn() }));
vi.mock("../lib/database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/database.ts")>();
  return { ...actual, queryAdmin: vi.fn(), query: vi.fn() };
});

function request(method: "GET" | "POST", body?: unknown, marker = true): Request {
  return new Request("https://example.test/api/admin/inventory", {
    method,
    headers: {
      Origin: "https://example.test",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(marker ? { "X-IUB-Admin": "1" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const input = {
  title: "Cien años de soledad",
  author: "Gabriel García Márquez",
  publisher: "Sudamericana",
  genre: "Novela",
  isbn: "9780306406157",
  inventoryCode: "INV-MAN-001",
  location: "Estante A",
  physicalCondition: "good",
  verificationReference: "Acta 2026-10-31",
  publish: true,
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
};

describe("administrative inventory registration", () => {
  beforeEach(() => {
    vi.mocked(requireAdmin).mockReturnValue({
      username: "manager",
      actorUserId: 7,
      expiresAt: 9999999999,
      sessionVersion: 1,
    } as ReturnType<typeof requireAdmin>);
    vi.mocked(assertActiveAdminActor).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the current inventory capabilities", async () => {
    vi.mocked(queryAdmin).mockResolvedValue([{
      can_register: true,
      can_verify: true,
      can_publish: false,
    }]);

    const response = await handler(request("GET"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      capabilities: { canRegister: true, canVerify: true, canPublish: false },
    });
  });

  it("registers a normalized, auditable copy", async () => {
    vi.mocked(queryAdmin).mockResolvedValue([{
      copy_id: "91",
      bibliographic_record_id: "44",
      inventory_code: "INV-MAN-001",
      availability: "available",
      verified: true,
      created: true,
    }]);

    const response = await handler(request("POST", input));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      copyId: "91",
      bibliographicRecordId: "44",
      inventoryCode: "INV-MAN-001",
      availability: "available",
      verified: true,
      published: true,
      created: true,
    });
    expect(vi.mocked(queryAdmin)).toHaveBeenCalledWith(
      expect.stringContaining("register_institutional_copy"),
      [
        "Cien años de soledad",
        "Gabriel García Márquez",
        "Sudamericana",
        "Novela",
        "9780306406157",
        "9780306406157",
        "INV-MAN-001",
        "Estante A",
        "good",
        "Acta 2026-10-31",
        true,
        7,
        "11111111-1111-4111-8111-111111111111",
      ],
    );
  });

  it("rejects invalid ISBN, missing verification and missing marker", async () => {
    const invalidIsbn = await handler(request("POST", { ...input, isbn: "123" }));
    expect(invalidIsbn.status).toBe(400);

    const missingReference = await handler(request("POST", {
      ...input,
      verificationReference: "",
    }));
    expect(missingReference.status).toBe(400);

    const missingMarker = await handler(request("POST", input, false));
    expect(missingMarker.status).toBe(403);
    expect(vi.mocked(queryAdmin)).not.toHaveBeenCalled();
  });

  it("maps database permission errors without exposing SQL", async () => {
    vi.mocked(queryAdmin).mockRejectedValueOnce(new DatabaseQueryError("42501"));
    const response = await handler(request("POST", input));
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).not.toContain("SQL");
    expect(text).not.toContain("permission denied");
  });
});
