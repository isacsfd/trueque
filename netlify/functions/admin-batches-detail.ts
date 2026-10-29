import { requireAdmin } from "../lib/auth.ts";
import { requireAdminPermission } from "../lib/admin-permissions.ts";
import { queryAdmin } from "../lib/database.ts";
import { ApiError, json, mapError, methodNotAllowed } from "../lib/http.ts";

interface BatchRow {
  source_row: number;
  status: string;
  errors: string[];
  warnings: string[];
  mapped_data: Record<string, string | null>;
  inventory_code: string | null;
  bibliographic_record_id: string | null;
  copy_id: string | null;
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();

  try {
    const session = requireAdmin(request);
    await requireAdminPermission(session.actorUserId, "inventory.batches.read");
    const url = new URL(request.url);
    const rawId = url.searchParams.get("id");
    if (!rawId || !/^[1-9][0-9]{0,15}$/.test(rawId)) {
      throw new ApiError(400, "invalid_field", "El lote solicitado no es válido.");
    }
    const id = Number(rawId);
    const batches = await queryAdmin<{
      id: string; file_name: string; file_sha256: string; file_size: number;
      sheet_name: string; header_row: number; column_mapping: Record<string, string>;
      status: string; total_rows: number; valid_rows: number; warning_rows: number;
      rejected_rows: number; duplicate_rows: number; inserted_rows: number;
      reused_rows: number; observations: string | null; created_by: string;
      created_at: string; confirmed_by: string | null; confirmed_at: string | null;
    }>(
      `SELECT b.id, b.file_name, encode(b.file_sha256, 'hex') AS file_sha256,
              b.file_size, b.sheet_name, b.header_row, b.column_mapping, b.status,
              b.total_rows, b.valid_rows, b.warning_rows, b.rejected_rows,
              b.duplicate_rows, b.inserted_rows, b.reused_rows, b.observations,
              u.identity_subject AS created_by, b.created_at,
              cu.identity_subject AS confirmed_by, b.confirmed_at
       FROM public.inventory_batches b
       JOIN public.app_users u ON u.id = b.created_by
       LEFT JOIN public.app_users cu ON cu.id = b.confirmed_by
       WHERE b.id = $1`,
      [id],
    );
    const batch = batches[0];
    if (!batch) throw new ApiError(404, "not_found", "No se encontró el lote.");

    const rows = await queryAdmin<BatchRow>(
      `SELECT source_row, status, errors, warnings, mapped_data, inventory_code,
              bibliographic_record_id, copy_id
       FROM public.inventory_batch_rows
       WHERE batch_id = $1
       ORDER BY source_row`,
      [id],
    );

    return json(200, {
      batch: {
        batchId: batch.id,
        fileName: batch.file_name,
        sha256: batch.file_sha256,
        fileSize: batch.file_size,
        sheetName: batch.sheet_name,
        headerRow: batch.header_row,
        mapping: batch.column_mapping,
        status: batch.status,
        totalRows: batch.total_rows,
        validRows: batch.valid_rows,
        warningRows: batch.warning_rows,
        rejectedRows: batch.rejected_rows,
        duplicateRows: batch.duplicate_rows,
        insertedRows: batch.inserted_rows,
        reusedRows: batch.reused_rows,
        observations: batch.observations,
        createdBy: batch.created_by,
        createdAt: batch.created_at,
        confirmedBy: batch.confirmed_by,
        confirmedAt: batch.confirmed_at,
      },
      rows: rows.map((row) => ({
        sourceRow: row.source_row,
        status: row.status,
        errors: row.errors,
        warnings: row.warnings,
        mapped: row.mapped_data,
        inventoryCode: row.inventory_code,
        bibliographicRecordId: row.bibliographic_record_id,
        copyId: row.copy_id,
      })),
    });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/batches/detail" };
