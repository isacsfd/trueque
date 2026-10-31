import { requireAdmin } from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { queryAdmin } from "../lib/database.ts";
import { ApiError, json, mapError, methodNotAllowed } from "../lib/http.ts";

interface DetailRow {
  request_id: string;
  history: Array<Record<string, unknown>>;
  deliveries: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
}

async function requireRead(actorUserId: number): Promise<void> {
  const rows = await queryAdmin<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM public.user_roles ur
       JOIN public.role_permissions rp ON rp.role_id = ur.role_id
       JOIN public.permissions p ON p.id = rp.permission_id
       WHERE ur.user_id = $1
         AND p.permission_key IN ('requests.read', 'requests.review')
     ) AS allowed`,
    [actorUserId],
  );
  if (rows[0]?.allowed !== true) {
    throw new ApiError(403, "forbidden", "No tienes permiso para consultar las solicitudes.");
  }
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  try {
    const session = requireAdmin(request);
    await assertActiveAdminActor(session.actorUserId, session.sessionVersion);
    await requireRead(session.actorUserId);

    const rawId = new URL(request.url).searchParams.get("requestId");
    if (!rawId || !/^[1-9][0-9]{0,15}$/.test(rawId)) {
      throw new ApiError(400, "invalid_field", "La solicitud no es válida.");
    }
    const requestId = Number(rawId);
    if (!Number.isSafeInteger(requestId)) {
      throw new ApiError(400, "invalid_field", "La solicitud no es válida.");
    }
    const schema = await queryAdmin<{ has_submissions: boolean }>(
      "SELECT to_regclass('public.offered_book_submissions') IS NOT NULL AS has_submissions",
    );
    const modern = schema[0]?.has_submissions === true;
    const evidenceSql = modern
      ? `coalesce((
           SELECT jsonb_agg(jsonb_build_object(
             'id', ev.id::text, 'slot', ev.slot, 'mime', ev.detected_mime,
             'bytes', ev.byte_size, 'width', ev.width, 'height', ev.height,
             'createdAt', ev.created_at
           ) ORDER BY ev.id)
           FROM public.offered_book_submissions s
           JOIN public.offered_book_evidence ev ON ev.submission_id = s.id
           WHERE s.request_id = r.id AND ev.deleted_at IS NULL
         ), '[]'::jsonb) AS evidence`
      : `'[]'::jsonb AS evidence`;

    const rows = await queryAdmin<DetailRow>(
      `SELECT
         r.id::text AS request_id,
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
             'previousStatus', h.previous_state,
             'newStatus', h.new_state,
             'changedBy', u.identity_subject,
             'changedAt', h.changed_at,
             'reason', h.reason
           ) ORDER BY h.changed_at, h.id)
           FROM public.state_history h
           LEFT JOIN public.app_users u ON u.id = h.changed_by
           WHERE h.entity_type = 'exchange_request' AND h.entity_id = r.id
         ), '[]'::jsonb) AS history,
         coalesce((
           SELECT json_agg(json_build_object(
             'id', d.id,
             'type', d.delivery_type,
             'status', d.status,
             'scheduledAt', d.scheduled_at,
             'completedAt', d.completed_at,
             'receiptReference', d.receipt_reference,
             'idempotencyKey', d.idempotency_key
           ) ORDER BY d.id)
           FROM public.deliveries d
           JOIN public.exchanges e ON e.id = d.exchange_id
           WHERE e.request_id = r.id
         ), '[]'::json) AS deliveries,
         ${evidenceSql}
       FROM public.exchange_requests r
       WHERE r.id = $1`,
      [requestId],
    );
    const row = rows[0];
    if (!row) throw new ApiError(404, "not_found", "Solicitud no encontrada.");
    return json(200, {
      requestId: row.request_id,
      history: row.history,
      deliveries: row.deliveries,
      evidence: row.evidence,
    });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/workbench/detail" };
