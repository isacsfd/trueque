// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireAdmin } from "../lib/auth.ts";
import { requireAdminPermission } from "../lib/admin-permissions.ts";
import { DatabaseQueryError, queryAdmin } from "../lib/database.ts";
import handler from "../functions/admin-workbench.ts";

vi.mock("../lib/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth.ts")>();
  return { ...actual, requireAdmin: vi.fn() };
});
vi.mock("../lib/admin-permissions.ts", () => ({ requireAdminPermission: vi.fn() }));
vi.mock("../lib/database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/database.ts")>();
  return { ...actual, queryAdmin: vi.fn(), query: vi.fn() };
});

describe("administrative workbench", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns request context and decision history behind requests.review", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "manager", actorUserId: 7, expiresAt: 9999999999 });
    vi.mocked(requireAdminPermission).mockResolvedValue(undefined);
    vi.mocked(queryAdmin).mockResolvedValue([{
      request_id: "1",
      request_code: "IUB-2026-1",
      request_status: "approved",
      created_at: "2026-10-01T00:00:00Z",
      requested_title: "Libro institucional",
      requested_inventory_code: "IUB-1",
      offered_title: "Libro ofrecido",
      offered_author: "Autora",
      offered_condition: "good",
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
        previousStatus: "under_review",
        newStatus: "approved",
        changedBy: "manager",
        changedAt: "2026-10-02T00:00:00Z",
        reason: "Documentación completa",
      }],
      deliveries: [],
    }]);

    const response = await handler(new Request("https://example.test/api/admin/workbench"));
    const body = await response.json() as { items: Array<Record<string, unknown>> };
    expect(response.status).toBe(200);
    expect(body.items[0]).toMatchObject({
      requestCode: "IUB-2026-1",
      history: [{ newStatus: "approved", reason: "Documentación completa" }],
    });
    expect(requireAdminPermission).toHaveBeenCalledWith(7, "requests.review");
  });

  it("rejects an actor without requests.review", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "viewer", actorUserId: 9, expiresAt: 9999999999 });
    vi.mocked(requireAdminPermission).mockRejectedValueOnce(new DatabaseQueryError("42501"));

    const response = await handler(new Request("https://example.test/api/admin/workbench"));
    expect(response.status).toBe(403);
    expect(queryAdmin).not.toHaveBeenCalled();
  });
});
