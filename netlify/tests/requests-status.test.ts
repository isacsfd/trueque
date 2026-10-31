// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { query } from "../lib/database.ts";
import handler from "../functions/requests-status.ts";

vi.mock("../lib/database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/database.ts")>();
  return { ...actual, query: vi.fn(), queryAdmin: vi.fn() };
});

const token = "token-de-consulta-con-mas-de-32-caracteres-123456";

function request(body: unknown): Request {
  return new Request("https://example.test/api/requests/status", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "203.0.113.30",
    },
    body: JSON.stringify(body),
  });
}

const row = {
  request_code: "IUB-2026-ABCD1234",
  status: "under_review",
  created_at: "2026-10-30T12:00:00Z",
  offered_title: "Libro ofrecido",
  offered_author: "Autora",
  requested_title: "Libro solicitado",
  requested_author: "Autor",
  requested_inventory_code: "INV-001",
  reservation_status: "active",
  reservation_expires_at: "2026-10-30T13:00:00Z",
  exchange_status: null,
  exchange_completed_at: null,
  reception_status: null,
};

function mockRateAndStatus() {
  vi.mocked(query).mockImplementation(async (sql) => {
    if (sql.includes("consume_public_status_rate_limit")) {
      return [{ allowed: true, retry_after_seconds: 0 }];
    }
    if (sql.includes("get_public_request_status_by_token")) return [row];
    return [];
  });
}

describe("public request status by token", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("accepts one token and returns only its status without a second credential", async () => {
    mockRateAndStatus();
    const response = await handler(request({ token }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      requestCode: "IUB-2026-ABCD1234",
      status: "under_review",
      requestedInventoryCode: "INV-001",
      reservationLabel: "Reservado temporalmente",
    });
    expect(JSON.stringify(body).toLowerCase()).not.toContain("password");
    expect(JSON.stringify(body).toLowerCase()).not.toContain("contraseña");
    expect(vi.mocked(query)).toHaveBeenCalledWith(
      "SELECT * FROM public.get_public_request_status_by_token($1)",
      [expect.any(Buffer)],
    );
  });

  it("rejects missing and malformed tokens before querying", async () => {
    const missing = await handler(request({}));
    expect(missing.status).toBe(400);
    const malformed = await handler(request({ token: "short" }));
    expect(malformed.status).toBe(400);
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });

  it("returns a generic 404 for an unknown token", async () => {
    vi.mocked(query).mockImplementation(async (sql) => {
      if (sql.includes("consume_public_status_rate_limit")) {
        return [{ allowed: true, retry_after_seconds: 0 }];
      }
      return [];
    });
    const response = await handler(request({ token }));
    expect(response.status).toBe(404);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/No encontramos una solicitud/);
    expect(body.error.message).not.toContain(token);
  });

  it("honors the database rate-limit decision", async () => {
    vi.mocked(query).mockResolvedValueOnce([{ allowed: false, retry_after_seconds: 12 }]);
    const response = await handler(request({ token }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
  });
});
