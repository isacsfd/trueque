import { requireAdmin } from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { queryAdmin } from "../lib/database.ts";
import { ApiError, json, mapError, methodNotAllowed } from "../lib/http.ts";

interface WorkbenchRow {
  request_id: string;
  request_code: string;
  request_status: string;
  created_at: string;
  requested_title: string;
  requested_inventory_code: string;
  offered_title: string;
  offered_author: string;
  offered_condition: string;
  submission_id: string | null;
  submission_status: string | null;
  submission_workflow_status: string | null;
  submission_title: string | null;
  submission_author: string | null;
  submission_condition: string | null;
  submission_observations: string | null;
  evidence: Array<{
    id: string;
    slot: string;
    mime: string;
    bytes: number;
    width: number;
    height: number;
    createdAt: string;
  }>;
  exchange_id: string | null;
  exchange_status: string | null;
  cancellation_key: string | null;
  reception_id: string | null;
  reception_status: string | null;
  evaluation_id: string | null;
  evaluation_outcome: string | null;
  cataloging_id: string | null;
  cataloging_status: string | null;
  admission_id: string | null;
  admission_status: string | null;
  offered_copy_id: string | null;
  history: Array<{
    previousStatus: string | null;
    newStatus: string;
    changedBy: string | null;
    changedAt: string;
    reason: string | null;
  }>;
  deliveries: Array<{
    id: string;
    type: string;
    status: string;
    scheduledAt: string | null;
    completedAt: string | null;
    receiptReference: string | null;
    idempotencyKey: string;
  }>;
}

const modernWorkbenchQuery = `
  SELECT
    r.id AS request_id,
    r.request_code,
    r.status AS request_status,
    r.created_at,
    b.title AS requested_title,
    c.inventory_code AS requested_inventory_code,
    ob.title AS offered_title,
    ob.author AS offered_author,
    ob.declared_condition AS offered_condition,
    s.id AS submission_id,
    s.status AS submission_status,
    w.workflow_status AS submission_workflow_status,
    s.title AS submission_title,
    s.author AS submission_author,
    s.declared_condition AS submission_condition,
    s.observations AS submission_observations,
    coalesce(
      (SELECT jsonb_agg(jsonb_build_object(
         'id', ev.id::text, 'slot', ev.slot, 'mime', ev.detected_mime,
         'bytes', ev.byte_size, 'width', ev.width, 'height', ev.height,
         'createdAt', ev.created_at
       ) ORDER BY ev.id)
       FROM public.offered_book_evidence ev
       WHERE ev.submission_id = s.id AND ev.deleted_at IS NULL),
      '[]'::jsonb
    ) AS evidence,
    e.id AS exchange_id,
    e.status AS exchange_status,
    e.cancellation_idempotency_key AS cancellation_key,
    rec.id AS reception_id,
    rec.status AS reception_status,
    ev.id AS evaluation_id,
    ev.outcome AS evaluation_outcome,
    cat.id AS cataloging_id,
    cat.status AS cataloging_status,
    a.id AS admission_id,
    a.status AS admission_status,
    a.copy_id AS offered_copy_id,
    coalesce(
      (SELECT jsonb_agg(jsonb_build_object(
         'previousStatus', h.previous_status,
         'newStatus', h.new_status,
         'changedBy', u.identity_subject,
         'changedAt', h.changed_at,
         'reason', h.reason
       ) ORDER BY h.changed_at, h.id)
       FROM public.request_status_history h
       LEFT JOIN public.app_users u ON u.id = h.changed_by
       WHERE h.request_id = r.id),
      '[]'::jsonb
    ) AS history,
    coalesce(
      (SELECT json_agg(json_build_object(
         'id', d.id,
         'type', d.delivery_type,
         'status', d.status,
         'scheduledAt', d.scheduled_at,
         'completedAt', d.completed_at,
         'receiptReference', d.receipt_reference,
         'idempotencyKey', d.idempotency_key
       ) ORDER BY d.id)
       FROM public.deliveries d WHERE d.exchange_id = e.id),
      '[]'::json
    ) AS deliveries
  FROM public.exchange_requests r
  JOIN public.copies c ON c.id = r.requested_copy_id
  JOIN public.bibliographic_records b ON b.id = c.bibliographic_record_id
  JOIN public.offered_books ob ON ob.request_id = r.id
  LEFT JOIN public.offered_book_submissions s ON s.request_id = r.id
  LEFT JOIN public.offered_book_submission_workflow w ON w.submission_id = s.id
  LEFT JOIN public.exchanges e ON e.request_id = r.id
  LEFT JOIN public.receptions rec ON rec.id = e.offered_reception_id
  LEFT JOIN public.book_evaluations ev ON ev.reception_id = rec.id AND ev.is_final
  LEFT JOIN public.cataloging_records cat ON cat.reception_id = rec.id
  LEFT JOIN public.inventory_admissions a ON a.reception_id = rec.id
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT 100`;

/**
 * Compatibility query for the deployed staging schema (0001-0005), which does
 * not have the photographic submission tables. The public catalogue and the
 * legacy request flow remain fully usable; the workbench simply reports no
 * photographic review data.
 */
const legacyWorkbenchQuery = `
  SELECT
    r.id AS request_id,
    r.request_code,
    r.status AS request_status,
    r.created_at,
    b.title AS requested_title,
    c.inventory_code AS requested_inventory_code,
    ob.title AS offered_title,
    ob.author AS offered_author,
    ob.declared_condition AS offered_condition,
    NULL::text AS submission_id,
    NULL::text AS submission_status,
    NULL::text AS submission_workflow_status,
    NULL::text AS submission_title,
    NULL::text AS submission_author,
    NULL::text AS submission_condition,
    NULL::text AS submission_observations,
    '[]'::jsonb AS evidence,
    e.id AS exchange_id,
    e.status AS exchange_status,
    e.cancellation_idempotency_key AS cancellation_key,
    rec.id AS reception_id,
    rec.status AS reception_status,
    ev.id AS evaluation_id,
    ev.outcome AS evaluation_outcome,
    cat.id AS cataloging_id,
    cat.status AS cataloging_status,
    a.id AS admission_id,
    a.status AS admission_status,
    a.copy_id AS offered_copy_id,
    '[]'::jsonb AS history,
    coalesce(
      (SELECT json_agg(json_build_object(
         'id', d.id,
         'type', d.delivery_type,
         'status', d.status,
         'scheduledAt', d.scheduled_at,
         'completedAt', d.completed_at,
         'receiptReference', d.receipt_reference,
         'idempotencyKey', d.idempotency_key
       ) ORDER BY d.id)
       FROM public.deliveries d WHERE d.exchange_id = e.id),
      '[]'::json
    ) AS deliveries
  FROM public.exchange_requests r
  JOIN public.copies c ON c.id = r.requested_copy_id
  JOIN public.bibliographic_records b ON b.id = c.bibliographic_record_id
  JOIN public.offered_books ob ON ob.request_id = r.id
  LEFT JOIN public.exchanges e ON e.request_id = r.id
  LEFT JOIN public.receptions rec ON rec.id = e.offered_reception_id
  LEFT JOIN public.book_evaluations ev ON ev.reception_id = rec.id AND ev.is_final
  LEFT JOIN public.cataloging_records cat ON cat.reception_id = rec.id
  LEFT JOIN public.inventory_admissions a ON a.reception_id = rec.id
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT 100`;

async function requireWorkbenchRead(actorUserId: number): Promise<void> {
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
    await requireWorkbenchRead(session.actorUserId);
    const capability = await queryAdmin<{ has_submissions: boolean }>(
      "SELECT to_regclass('public.offered_book_submissions') IS NOT NULL AS has_submissions",
    );
    const rows = await queryAdmin<WorkbenchRow>(
      capability[0]?.has_submissions ? modernWorkbenchQuery : legacyWorkbenchQuery,
    );

    return json(200, {
      items: rows.map((row) => ({
        requestId: row.request_id,
        requestCode: row.request_code,
        requestStatus: row.request_status,
        createdAt: row.created_at,
        requestedTitle: row.requested_title,
        requestedInventoryCode: row.requested_inventory_code,
        offeredTitle: row.offered_title,
        offeredAuthor: row.offered_author,
        offeredCondition: row.offered_condition,
        submissionId: row.submission_id,
        submissionStatus: row.submission_status,
        submissionWorkflowStatus: row.submission_workflow_status,
        submissionTitle: row.submission_title,
        submissionAuthor: row.submission_author,
        submissionCondition: row.submission_condition,
        submissionObservations: row.submission_observations,
        evidence: row.evidence,
        exchangeId: row.exchange_id,
        exchangeStatus: row.exchange_status,
        cancellationKey: row.cancellation_key,
        receptionId: row.reception_id,
        receptionStatus: row.reception_status,
        evaluationId: row.evaluation_id,
        evaluationOutcome: row.evaluation_outcome,
        catalogingId: row.cataloging_id,
        catalogingStatus: row.cataloging_status,
        admissionId: row.admission_id,
        admissionStatus: row.admission_status,
        offeredCopyId: row.offered_copy_id,
        history: row.history,
        deliveries: row.deliveries,
      })),
    });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/workbench" };
