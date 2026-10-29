import { requireAdmin } from "../lib/auth.ts";
import { requireAdminPermission } from "../lib/admin-permissions.ts";
import { queryAdmin } from "../lib/database.ts";
import { json, mapError, methodNotAllowed } from "../lib/http.ts";

interface BatchListRow {
  id: string;
  file_name: string;
  file_sha256: string;
  file_size: number;
  sheet_name: string;
  status: string;
  total_rows: number;
  valid_rows: number;
  warning_rows: number;
  rejected_rows: number;
  duplicate_rows: number;
  inserted_rows: number;
  reused_rows: number;
  observations: string | null;
  created_by: string;
  created_at: string;
  confirmed_at: string | null;
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();

  try {
    const session = requireAdmin(request);
    await requireAdminPermission(session.actorUserId, "inventory.batches.read");
    const rows = await queryAdmin<BatchListRow>(
      `SELECT b.id, b.file_name, encode(b.file_sha256, 'hex') AS file_sha256,
              b.file_size, b.sheet_name, b.status, b.total_rows, b.valid_rows,
              b.warning_rows, b.rejected_rows, b.duplicate_rows, b.inserted_rows,
              b.reused_rows, b.observations, u.identity_subject AS created_by,
              b.created_at, b.confirmed_at
       FROM public.inventory_batches b
       JOIN public.app_users u ON u.id = b.created_by
       ORDER BY b.created_at DESC, b.id DESC
       LIMIT 100`,
    );
    return json(200, {
      items: rows.map((row) => ({
        batchId: row.id,
        fileName: row.file_name,
        sha256: row.file_sha256,
        fileSize: row.file_size,
        sheetName: row.sheet_name,
        status: row.status,
        totalRows: row.total_rows,
        validRows: row.valid_rows,
        warningRows: row.warning_rows,
        rejectedRows: row.rejected_rows,
        duplicateRows: row.duplicate_rows,
        insertedRows: row.inserted_rows,
        reusedRows: row.reused_rows,
        observations: row.observations,
        createdBy: row.created_by,
        createdAt: row.created_at,
        confirmedAt: row.confirmed_at,
      })),
    });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/batches/list" };
