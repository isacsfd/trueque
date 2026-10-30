// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptPersonalData } from "../lib/crypto.ts";
import { requireAdmin } from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { DatabaseQueryError, queryAdmin } from "../lib/database.ts";
import handler from "../functions/admin-workbench.ts";

vi.mock("../lib/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth.ts")>();
  return { ...actual, requireAdmin: vi.fn() };
});
vi.mock("../lib/admin-identity.ts", () => ({ assertActiveAdminActor: vi.fn() }));
vi.mock("../lib/database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/database.ts")>();
  return { ...actual, queryAdmin: vi.fn(), query: vi.fn() };
});

const DATA_KEY = Buffer.alloc(32, 7);

function workbenchRow() {
  return {
    request_id: "1",
    request_code: "IUB-2026-1",
    request_status: "under_review",
    created_at: "2026-10-01T00:00:00Z",
    participant_id: "4",
    requested_title: "Libro institucional",
    requested_author: "Autora institucional",
    requested_isbn: "9789585810358",
    requested_publisher: "Editorial",
    requested_genre: "Novela",
    requested_edition: null,
    requested_publication_year: 2020,
    requested_inventory_code: "INV-063",
    requested_availability: "available",
    requested_condition: "good",
    requested_location: "Plaza de la Paz",
    reservation_id: "9",
    reservation_status: "converted",
    reservation_created_at: "2026-10-01T00:00:00Z",
    reservation_expires_at: "2026-10-01T01:00:00Z",
    reservation_released_at: "2026-10-01T00:30:00Z",
    offered_title: "Libro ofrecido",
    offered_author: "Autora",
    offered_isbn: null,
    offered_publisher: "Editorial ofrecida",
    offered_genre: "Ensayo",
    offered_condition: "good",
    offered_observations: "Buen estado",
    submission_id: null,
    submission_status: null,
    submission_workflow_status: null,
    submission_title: null,
    submission_author: null,
    submission_condition: null,
    submission_observations: null,
    evidence: [],
    exchange_id: null,
    exchange_status: null,
    cancellation_key: null,
    reception_id: null,
    reception_status: null,
    evaluation_id: null,
    evaluation_outcome: null,
    cataloging_id: null,
    cataloging_status: null,
    admission_id: null,
    admission_status: null,
    offered_copy_id: null,
    history: [{
      previousStatus: "pending",
      newStatus: "under_review",
      changedBy: "manager",
      changedAt: "2026-10-02T00:00:00Z",
      reason: "Documentación completa",
    }],
    deliveries: [],
  };
}

describe("administrative workbench", () => {
  beforeEach(() => {
    vi.stubEnv("PARTICIPANT_DATA_KEY", DATA_KEY.toString("base64"));
    vi.stubEnv("PARTICIPANT_IDENTITY_HMAC_KEY", DATA_KEY.toString("base64"));
    vi.stubEnv("PRIVACY_NOTICE_VERSION", "2026-10");
    vi.stubEnv("PARTICIPANT_DATA_KEY_VERSION", "1");
    vi.stubEnv("PARTICIPANT_HMAC_KEY_VERSION", "1");
    vi.mocked(assertActiveAdminActor).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns student, offered book, requested book and decision history", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "manager", actorUserId: 7, expiresAt: 9999999999 });
    vi.mocked(queryAdmin).mockImplementation(async (sql) => {
      if (sql.includes("AS allowed")) return [{ allowed: true }];
      if (sql.includes("AS can_review")) {
        return [{
          can_review: true,
          can_import: false,
          can_read_batches: true,
          can_read_contact: true,
          can_manage_accounts: false,
        }];
      }
      if (sql.includes("to_regclass")) return [{ has_submissions: false }];
      if (sql.includes("FROM public.exchange_requests")) return [workbenchRow()];
      if (sql.includes("get_participant_contact")) {
        return [{
          participant_id: "4",
          full_name_ciphertext: encryptPersonalData("Estudiante de Prueba", DATA_KEY),
          email_ciphertext: encryptPersonalData("estudiante@example.test", DATA_KEY),
        }];
      }
      return [];
    });

    const response = await handler(new Request("https://example.test/api/admin/workbench"));
    const body = await response.json() as {
      items: Array<Record<string, unknown>>;
      capabilities: Record<string, boolean>;
    };
    expect(response.status).toBe(200);
    expect(body.items[0]).toMatchObject({
      requestCode: "IUB-2026-1",
      student: { fullName: "Estudiante de Prueba", email: "estudiante@example.test" },
      offeredBook: { title: "Libro ofrecido", author: "Autora" },
      requestedBook: {
        title: "Libro institucional",
        author: "Autora institucional",
        isbn: "9789585810358",
        inventoryCode: "INV-063",
        availability: "available",
      },
      reservation: {
        id: "9",
        status: "converted",
      },
      history: [{ newStatus: "under_review", reason: "Documentación completa" }],
      dataStatus: { complete: true },
    });
    expect(body.capabilities.can_review).toBe(true);
  });

  it("marks restricted contact instead of failing the workbench", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "viewer", actorUserId: 9, expiresAt: 9999999999 });
    vi.mocked(queryAdmin).mockImplementation(async (sql) => {
      if (sql.includes("AS allowed")) return [{ allowed: true }];
      if (sql.includes("AS can_review")) {
        return [{
          can_review: false,
          can_import: false,
          can_read_batches: false,
          can_read_contact: false,
          can_manage_accounts: false,
        }];
      }
      if (sql.includes("to_regclass")) return [{ has_submissions: false }];
      if (sql.includes("FROM public.exchange_requests")) return [workbenchRow()];
      return [];
    });

    const response = await handler(new Request("https://example.test/api/admin/workbench"));
    const body = await response.json() as { items: Array<Record<string, unknown>> };
    expect(response.status).toBe(200);
    expect(body.items[0]).toMatchObject({
      student: { fullName: null, email: null, restricted: true },
    });
  });

  it("rejects an actor without requests.read or requests.review", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "viewer", actorUserId: 9, expiresAt: 9999999999 });
    vi.mocked(queryAdmin).mockResolvedValueOnce([{ allowed: false }]);

    const response = await handler(new Request("https://example.test/api/admin/workbench"));
    expect(response.status).toBe(403);
  });

  it("does not expose PostgreSQL messages when the read check fails", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "viewer", actorUserId: 9, expiresAt: 9999999999 });
    vi.mocked(queryAdmin).mockRejectedValueOnce(new DatabaseQueryError("42501"));

    const response = await handler(new Request("https://example.test/api/admin/workbench"));
    expect(response.status).toBe(403);
  });
});
