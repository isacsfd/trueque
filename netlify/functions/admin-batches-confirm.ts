import { requireAdmin } from "../lib/auth.ts";
import { requireAdminPermission } from "../lib/admin-permissions.ts";
import { DatabaseQueryError, queryAdmin } from "../lib/database.ts";
import {
  ApiError,
  assertSameOrigin,
  json,
  mapError,
  methodNotAllowed,
  numberField,
  readJson,
  uuidField,
} from "../lib/http.ts";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();

  try {
    assertSameOrigin(request);
    const session = requireAdmin(request);
    await requireAdminPermission(session.actorUserId, "inventory.batches.confirm");
    const body = await readJson(request);
    const batchId = numberField(body, "batchId");
    const idempotencyKey = uuidField(body, "idempotencyKey");

    interface ConfirmRow {
      batch_id: string;
      status: string;
      inserted_rows: number;
      reused_rows: number;
      skipped_rows: number;
      auto_published?: number;
      auto_skipped?: number;
    }

    let rows: ConfirmRow[];
    try {
      rows = await queryAdmin<ConfirmRow>(
        "SELECT * FROM public.confirm_inventory_batch_with_publication($1, $2, $3)",
        [batchId, session.actorUserId, idempotencyKey],
      );
    } catch (error) {
      // Environments created before 0023 keep the original confirmation
      // behavior. The new routine is optional until the migration is applied.
      if (error instanceof DatabaseQueryError && error.sqlState === "42883") {
        rows = await queryAdmin<ConfirmRow>(
          "SELECT * FROM public.confirm_inventory_batch($1, $2, $3)",
          [batchId, session.actorUserId, idempotencyKey],
        );
      } else {
        throw error;
      }
    }

    const row = rows[0];
    if (!row) throw new ApiError(503, "confirmation_failed", "No se pudo confirmar el lote.");
    return json(200, {
      batchId: row.batch_id,
      status: row.status,
      insertedRows: row.inserted_rows,
      reusedRows: row.reused_rows,
      skippedRows: row.skipped_rows,
      autoPublished: row.auto_published ?? 0,
      autoSkipped: row.auto_skipped ?? 0,
    });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/batches/confirm" };
