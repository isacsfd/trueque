import { requireAdmin } from "../lib/auth.ts";
import { requireAdminPermission } from "../lib/admin-permissions.ts";
import { queryAdmin } from "../lib/database.ts";
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
    const rows = await queryAdmin<{
      batch_id: string;
      status: string;
      inserted_rows: number;
      reused_rows: number;
      skipped_rows: number;
    }>("SELECT * FROM public.confirm_inventory_batch($1, $2, $3)", [
      batchId, session.actorUserId, idempotencyKey,
    ]);
    const row = rows[0];
    if (!row) throw new ApiError(503, "confirmation_failed", "No se pudo confirmar el lote.");
    return json(200, {
      batchId: row.batch_id,
      status: row.status,
      insertedRows: row.inserted_rows,
      reusedRows: row.reused_rows,
      skippedRows: row.skipped_rows,
    });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/batches/confirm" };
