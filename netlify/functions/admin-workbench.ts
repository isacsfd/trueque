import { requireAdmin } from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { queryAdmin } from "../lib/database.ts";
import { decryptPersonalData, participantCryptoConfig } from "../lib/crypto.ts";
import { ApiError, json, mapError, methodNotAllowed } from "../lib/http.ts";

interface WorkbenchRow {
  request_id: string;
  request_code: string;
  request_status: string;
  created_at: string;
  participant_id: string | null;
  requested_title: string | null;
  requested_author: string | null;
  requested_isbn: string | null;
  requested_publisher: string | null;
  requested_genre: string | null;
  requested_edition: string | null;
  requested_publication_year: number | null;
  requested_inventory_code: string | null;
  requested_availability: string | null;
  requested_condition: string | null;
  requested_location: string | null;
  offered_title: string | null;
  offered_author: string | null;
  offered_isbn: string | null;
  offered_publisher: string | null;
  offered_genre: string | null;
  offered_condition: string | null;
  offered_observations: string | null;
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

interface WorkbenchCapabilities {
  can_review: boolean;
  can_import: boolean;
  can_read_batches: boolean;
  can_read_contact: boolean;
  can_manage_accounts: boolean;
}

interface ParticipantContact {
  fullName: string | null;
  email: string | null;
  restricted: boolean;
  registered: boolean;
}

const requestSelect = `
    r.id AS request_id,
    r.request_code,
    r.status AS request_status,
    r.created_at,
    r.participant_id,
    b.title AS requested_title,
    b.author AS requested_author,
    b.isbn AS requested_isbn,
    rp.name AS requested_publisher,
    rg.name AS requested_genre,
    b.edition AS requested_edition,
    b.publication_year AS requested_publication_year,
    c.inventory_code AS requested_inventory_code,
    c.availability AS requested_availability,
    c.physical_condition AS requested_condition,
    c.location AS requested_location,
    ob.title AS offered_title,
    ob.author AS offered_author,
    ob.isbn AS offered_isbn,
    ob.publisher_claim AS offered_publisher,
    ob.genre_claim AS offered_genre,
    ob.declared_condition AS offered_condition,
    ob.observations AS offered_observations,`;

const submissionSelect = (modern: boolean) => modern
  ? `
    s.id AS submission_id,
    s.status AS submission_status,
    w.workflow_status AS submission_workflow_status,
    s.title AS submission_title,
    s.author AS submission_author,
    s.declared_condition AS submission_condition,
    s.observations AS submission_observations,`
  : `
    NULL::text AS submission_id,
    NULL::text AS submission_status,
    NULL::text AS submission_workflow_status,
    NULL::text AS submission_title,
    NULL::text AS submission_author,
    NULL::text AS submission_condition,
    NULL::text AS submission_observations,`;

const submissionEvidence = (modern: boolean) => modern
  ? `
    coalesce(
      (SELECT jsonb_agg(jsonb_build_object(
         'id', ev.id::text, 'slot', ev.slot, 'mime', ev.detected_mime,
         'bytes', ev.byte_size, 'width', ev.width, 'height', ev.height,
         'createdAt', ev.created_at
       ) ORDER BY ev.id)
       FROM public.offered_book_evidence ev
       WHERE ev.submission_id = s.id AND ev.deleted_at IS NULL),
      '[]'::jsonb
    ) AS evidence,`
  : `'[]'::jsonb AS evidence,`;

const submissionJoins = (modern: boolean) => modern
  ? `
  LEFT JOIN public.offered_book_submissions s ON s.request_id = r.id
  LEFT JOIN public.offered_book_submission_workflow w ON w.submission_id = s.id`
  : "";

/**
 * The live staging database is on the 0001-0005 schema. Keep the workbench
 * compatible with both that schema and the newer photographic submission
 * schema. The history is read from state_history, available in both versions.
 */
function workbenchQuery(modern: boolean): string {
  return `
  SELECT
${requestSelect}
${submissionSelect(modern)}
${submissionEvidence(modern)}
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
         'previousStatus', h.previous_state,
         'newStatus', h.new_state,
         'changedBy', u.identity_subject,
         'changedAt', h.changed_at,
         'reason', h.reason
       ) ORDER BY h.changed_at, h.id)
       FROM public.state_history h
       LEFT JOIN public.app_users u ON u.id = h.changed_by
       WHERE h.entity_type = 'exchange_request' AND h.entity_id = r.id),
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
  LEFT JOIN public.copies c ON c.id = r.requested_copy_id
  LEFT JOIN public.bibliographic_records b ON b.id = c.bibliographic_record_id
  LEFT JOIN public.publishers rp ON rp.id = b.publisher_id
  LEFT JOIN public.genres rg ON rg.id = b.genre_id
  LEFT JOIN public.offered_books ob ON ob.request_id = r.id
${submissionJoins(modern)}
  LEFT JOIN public.exchanges e ON e.request_id = r.id
  LEFT JOIN public.receptions rec ON rec.id = e.offered_reception_id
  LEFT JOIN public.book_evaluations ev ON ev.reception_id = rec.id AND ev.is_final
  LEFT JOIN public.cataloging_records cat ON cat.reception_id = rec.id
  LEFT JOIN public.inventory_admissions a ON a.reception_id = rec.id
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT 100`;
}

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

async function loadCapabilities(actorUserId: number): Promise<WorkbenchCapabilities> {
  const rows = await queryAdmin<WorkbenchCapabilities>(
    `SELECT
       EXISTS (
         SELECT 1 FROM public.user_roles ur
         JOIN public.role_permissions rp ON rp.role_id = ur.role_id
         JOIN public.permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = $1 AND p.permission_key = 'requests.review'
       ) AS can_review,
       EXISTS (
         SELECT 1 FROM public.user_roles ur
         JOIN public.role_permissions rp ON rp.role_id = ur.role_id
         JOIN public.permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = $1 AND p.permission_key = 'inventory.batches.import'
       ) AS can_import,
       EXISTS (
         SELECT 1 FROM public.user_roles ur
         JOIN public.role_permissions rp ON rp.role_id = ur.role_id
         JOIN public.permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = $1 AND p.permission_key = 'inventory.batches.read'
       ) AS can_read_batches,
       EXISTS (
         SELECT 1 FROM public.user_roles ur
         JOIN public.role_permissions rp ON rp.role_id = ur.role_id
         JOIN public.permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = $1 AND p.permission_key = 'participants.read_contact'
       ) AS can_read_contact,
       EXISTS (
         SELECT 1 FROM public.user_roles ur
         JOIN public.role_permissions rp ON rp.role_id = ur.role_id
         JOIN public.permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = $1 AND p.permission_key = 'account.manage'
       ) AS can_manage_accounts`,
    [actorUserId],
  );
  return rows[0] ?? {
    can_review: false,
    can_import: false,
    can_read_batches: false,
    can_read_contact: false,
    can_manage_accounts: false,
  };
}

async function loadContacts(
  participantIds: string[],
  actorUserId: number,
  canReadContact: boolean,
): Promise<Map<string, ParticipantContact>> {
  const contacts = new Map<string, ParticipantContact>();
  if (participantIds.length === 0) return contacts;

  let dataKey: Buffer | null = null;
  if (canReadContact) {
    try {
      dataKey = participantCryptoConfig().dataKey;
    } catch {
      dataKey = null;
    }
  }

  for (const participantId of participantIds) {
    if (!/^[1-9][0-9]{0,15}$/.test(participantId)) {
      contacts.set(participantId, { fullName: null, email: null, restricted: true, registered: false });
      continue;
    }
    if (!dataKey) {
      contacts.set(participantId, { fullName: null, email: null, restricted: true, registered: true });
      continue;
    }
    try {
      const rows = await queryAdmin<{
        participant_id: string;
        full_name_ciphertext: Uint8Array | null;
        email_ciphertext: Uint8Array | null;
      }>(
        "SELECT participant_id, full_name_ciphertext, email_ciphertext FROM public.get_participant_contact($1, $2)",
        [Number(participantId), actorUserId],
      );
      const row = rows[0];
      if (!row) {
        contacts.set(participantId, { fullName: null, email: null, restricted: false, registered: false });
        continue;
      }
      const fullName = row.full_name_ciphertext
        ? decryptPersonalData(Buffer.from(row.full_name_ciphertext), dataKey)
        : null;
      const email = row.email_ciphertext
        ? decryptPersonalData(Buffer.from(row.email_ciphertext), dataKey)
        : null;
      contacts.set(participantId, { fullName, email, restricted: false, registered: true });
    } catch {
      contacts.set(participantId, { fullName: null, email: null, restricted: true, registered: true });
    }
  }
  return contacts;
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();

  try {
    const session = requireAdmin(request);
    await assertActiveAdminActor(session.actorUserId, session.sessionVersion);
    await requireWorkbenchRead(session.actorUserId);
    const capabilities = await loadCapabilities(session.actorUserId);
    const schema = await queryAdmin<{ has_submissions: boolean }>(
      "SELECT to_regclass('public.offered_book_submissions') IS NOT NULL AS has_submissions",
    );
    const modern = schema[0]?.has_submissions === true;
    const rows = await queryAdmin<WorkbenchRow>(workbenchQuery(modern));
    const participantIds = [...new Set(
      rows.map((row) => row.participant_id).filter((value): value is string => Boolean(value)),
    )];
    const contacts = await loadContacts(
      participantIds,
      session.actorUserId,
      capabilities.can_read_contact,
    );

    return json(200, {
      items: rows.map((row) => {
        const contact = row.participant_id ? contacts.get(row.participant_id) : undefined;
        const student = {
          fullName: contact?.fullName ?? null,
          email: contact?.email ?? null,
          institutionalCode: null,
          academicProgram: null,
          restricted: contact?.restricted ?? Boolean(row.participant_id),
          registered: contact?.registered ?? false,
          participantId: row.participant_id,
        };
        const missing: string[] = [];
        if (!row.participant_id) missing.push("student");
        if (!student.fullName) missing.push("studentName");
        if (!student.email) missing.push("studentEmail");
        if (!row.offered_title) missing.push("offeredBook");
        if (!row.requested_title) missing.push("requestedBook");

        return {
          requestId: row.request_id,
          requestCode: row.request_code,
          requestStatus: row.request_status,
          createdAt: row.created_at,
          requestedTitle: row.requested_title,
          requestedInventoryCode: row.requested_inventory_code,
          offeredTitle: row.offered_title,
          offeredAuthor: row.offered_author,
          offeredCondition: row.offered_condition,
          student,
          offeredBook: {
            title: row.offered_title,
            author: row.offered_author,
            isbn: row.offered_isbn,
            publisher: row.offered_publisher,
            genre: row.offered_genre,
            condition: row.offered_condition,
            observations: row.offered_observations,
          },
          requestedBook: {
            title: row.requested_title,
            author: row.requested_author,
            isbn: row.requested_isbn,
            publisher: row.requested_publisher,
            genre: row.requested_genre,
            edition: row.requested_edition,
            publicationYear: row.requested_publication_year,
            inventoryCode: row.requested_inventory_code,
            availability: row.requested_availability,
            physicalCondition: row.requested_condition,
            location: row.requested_location,
            selectedAt: row.created_at,
          },
          dataStatus: {
            complete: missing.length === 0,
            missing,
            legacyIncomplete: !row.participant_id || !row.offered_title || !row.requested_title,
          },
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
        };
      }),
      capabilities,
    });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/workbench" };
