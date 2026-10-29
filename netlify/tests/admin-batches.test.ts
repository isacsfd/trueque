// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireAdmin } from "../lib/auth.ts";
import { requireAdminPermission } from "../lib/admin-permissions.ts";
import { queryAdmin } from "../lib/database.ts";
import batchHandler from "../functions/admin-batches.ts";
import confirmHandler from "../functions/admin-batches-confirm.ts";
import cancelHandler from "../functions/admin-batches-cancel.ts";
import listHandler from "../functions/admin-batches-list.ts";
import reportHandler from "../functions/admin-batches-report.ts";

vi.mock("../lib/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth.ts")>();
  return { ...actual, requireAdmin: vi.fn() };
});
vi.mock("../lib/admin-permissions.ts", () => ({ requireAdminPermission: vi.fn() }));
vi.mock("../lib/database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/database.ts")>();
  return { ...actual, queryAdmin: vi.fn(), query: vi.fn() };
});

function adminRequest(path: string, body: BodyInit, method = "POST"): Request {
  return new Request(`https://example.test${path}`, {
    method,
    headers: {
      "X-IUB-Admin": "1",
      Origin: "https://example.test",
      ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}),
    },
    body,
  });
}

function formRequest(fields: Record<string, string>, file: File): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set("file", file);
  return adminRequest("/api/admin/batches", form);
}

describe("administrative inventory batches API", () => {
  let directory: string;
  let workbook: Buffer;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "trueque-batches-"));
    vi.stubEnv("BATCH_STORAGE_DIR", directory);
    vi.mocked(requireAdmin).mockReturnValue({ username: "admin", actorUserId: 7, expiresAt: 9999999999 });
    vi.mocked(requireAdminPermission).mockResolvedValue(undefined);
    workbook = await readFile(new URL("../../INVENTARIO TRUEQUE.xlsx", import.meta.url));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("inspects a real XLSX and returns headers without touching the database", async () => {
    const response = await batchHandler(formRequest({ action: "inspect" }, new File([new Uint8Array(workbook)], "inventario.xlsx")));
    const body = await response.json() as { mode: string; selected: { headerRow: number; headers: string[] } };

    expect(response.status).toBe(200);
    expect(body.mode).toBe("inspect");
    expect(body.selected.headerRow).toBe(2);
    expect(body.selected.headers).toContain("TITULO");
    expect(queryAdmin).not.toHaveBeenCalled();
  });

  it("rejects a file that is not a real XLSX", async () => {
    const response = await batchHandler(formRequest({ action: "inspect" }, new File(["not a zip"], "inventario.xlsx")));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("ZIP/XLSX");
  });

  it("stores a prevalidation and keeps the original file private", async () => {
    vi.mocked(queryAdmin).mockImplementation(async (sql) => {
      if (sql.includes("FROM public.bibliographic_records")) return [];
      if (sql.includes("FROM public.copies")) return [];
      if (sql.includes("store_inventory_batch")) {
        return [{
          batch_id: "12", status: "prevalidated", total_rows: 67, valid_rows: 63,
          warning_rows: 4, rejected_rows: 0, duplicate_rows: 0,
        }];
      }
      return [];
    });

    const response = await batchHandler(formRequest({
      action: "prevalidate",
      sheetName: "Hoja1",
      headerRow: "2",
      mapping: JSON.stringify({ title: "TITULO", author: "AUTOR", publisher: "EDITORIAL" }),
      observations: "Lote de prueba",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    }, new File([new Uint8Array(workbook)], "inventario.xlsx")));
    const body = await response.json() as { mode: string; batchId: string; validRows: number };

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ mode: "prevalidated", batchId: "12", validRows: 63 });
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("confirms and cancels batches through permissioned routines", async () => {
    vi.mocked(queryAdmin)
      .mockResolvedValueOnce([{ batch_id: "12", status: "confirmed", inserted_rows: 2, reused_rows: 1, skipped_rows: 0 }])
      .mockResolvedValueOnce([{ batch_id: "13", status: "cancelled" }]);

    const confirmed = await confirmHandler(adminRequest("/api/admin/batches/confirm", JSON.stringify({
      batchId: 12, idempotencyKey: "11111111-1111-4111-8111-111111111111",
    }), "POST"));
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ insertedRows: 2, reusedRows: 1 });

    const cancelled = await cancelHandler(adminRequest("/api/admin/batches/cancel", JSON.stringify({
      batchId: 13, idempotencyKey: "11111111-1111-4111-8111-111111111112",
    }), "POST"));
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: "cancelled" });
  });

  it("lists batches and neutralizes CSV formula injection in reports", async () => {
    vi.mocked(queryAdmin).mockImplementation(async (sql) => {
      if (sql.includes("FROM public.inventory_batches b") && sql.includes("ORDER BY b.created_at")) {
        return [{
          id: "12", file_name: "lote.xlsx", file_sha256: "ab".repeat(32), file_size: 100,
          sheet_name: "Hoja1", status: "prevalidated", total_rows: 1, valid_rows: 1,
          warning_rows: 0, rejected_rows: 0, duplicate_rows: 0, inserted_rows: 0,
          reused_rows: 0, observations: null, created_by: "admin",
          created_at: "2026-10-29T00:00:00Z", confirmed_at: null,
        }];
      }
      if (sql.includes("FROM public.inventory_batch_rows")) {
        return [{
          source_row: 2, status: "valid",
          mapped_data: { title: "=HYPERLINK(\"x\")", author: "Autor", publisher: "Editor", isbn: null, inventory_code: null },
          errors: [], warnings: [], inventory_code: null,
        }];
      }
      return [];
    });

    const list = await listHandler(new Request("https://example.test/api/admin/batches/list"));
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ items: [{ batchId: "12", fileName: "lote.xlsx" }] });

    const report = await reportHandler(new Request("https://example.test/api/admin/batches/report?id=12"));
    expect(report.status).toBe(200);
    expect(report.headers.get("content-disposition")).toContain("lote-12-validacion.csv");
    expect(await report.text()).toContain("'=HYPERLINK");
  });

  it("rejects a request without the admin CSRF marker before processing the file", async () => {
    const form = new FormData();
    form.set("action", "inspect");
    form.set("file", new File([new Uint8Array(workbook)], "inventario.xlsx"));
    const response = await batchHandler(new Request("https://example.test/api/admin/batches", {
      method: "POST",
      body: form,
    }));
    expect(response.status).toBe(403);
  });
});
