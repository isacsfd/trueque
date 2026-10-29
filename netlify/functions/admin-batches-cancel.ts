import { requireAdmin } from "../lib/auth.ts";
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
    const body = await readJson(request);
    const batchId = numberField(body, "batchId");
    const idempotencyKey = uuidField(body, "idempotencyKey");
    const rows = await queryAdmin<{ batch_id: string; status: string }>(
      "SELECT * FROM public.cancel_inventory_batch($1, $2, $3)",
      [batchId, session.actorUserId, idempotencyKey],
    );
    const row = rows[0];
    if (!row) throw new ApiError(503, "cancel_failed", "No se pudo cancelar el lote.");
    return json(200, { batchId: row.batch_id, status: row.status });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/batches/cancel" };
