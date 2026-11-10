import { requireAdmin } from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { queryAdmin } from "../lib/database.ts";
import { ApiError, json, mapError, methodNotAllowed } from "../lib/http.ts";

const statuses = [
  "reserved",
  "committed",
  "lent",
  "return_pending",
  "completed",
  "cancelled",
  "expired",
] as const;

interface LoanRow {
  loan_id: string;
  request_id: string;
  request_code: string;
  reservation_id: string;
  exchange_id: string | null;
  copy_id: string;
  inventory_code: string;
  title: string;
  author: string;
  status: string;
  started_at: string;
  due_at: string;
  closed_at: string | null;
  dropoff_delivery_id: string | null;
  handover_delivery_id: string | null;
  return_delivery_id: string | null;
}

interface CountRow {
  total: number;
}

async function requireLoanRead(actorUserId: number): Promise<void> {
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
    throw new ApiError(403, "forbidden", "No tienes permiso para consultar el historial de préstamos.");
  }
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();

  try {
    const session = requireAdmin(request);
    await assertActiveAdminActor(session.actorUserId, session.sessionVersion);

    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    if (status !== null && status !== "" && !statuses.includes(status as typeof statuses[number])) {
      throw new ApiError(400, "invalid_query", "El estado del préstamo no es válido.");
    }

    await requireLoanRead(session.actorUserId);
    const rawPage = url.searchParams.get("page") ?? "1";
    const rawPageSize = url.searchParams.get("pageSize") ?? "25";
    const page = Number(rawPage);
    const pageSize = Number(rawPageSize);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
      throw new ApiError(400, "invalid_query", "La página no es válida.");
    }
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new ApiError(400, "invalid_query", "El tamaño de página no es válido.");
    }

    const values: Array<string | number | null> = [status || null, pageSize, (page - 1) * pageSize];
    const rows = await queryAdmin<LoanRow>(
      `SELECT l.id::text AS loan_id,
              l.request_id::text AS request_id,
              er.request_code,
              l.reservation_id::text AS reservation_id,
              l.exchange_id::text AS exchange_id,
              l.copy_id::text AS copy_id,
              c.inventory_code,
              b.title,
              b.author,
              l.status,
              l.started_at,
              l.due_at,
              l.closed_at,
              l.dropoff_delivery_id::text AS dropoff_delivery_id,
              l.handover_delivery_id::text AS handover_delivery_id,
              l.return_delivery_id::text AS return_delivery_id
       FROM public.loans l
       JOIN public.exchange_requests er ON er.id = l.request_id
       JOIN public.copies c ON c.id = l.copy_id
       JOIN public.bibliographic_records b ON b.id = c.bibliographic_record_id
       WHERE ($1::text IS NULL OR l.status = $1)
       ORDER BY l.started_at DESC, l.id DESC
       LIMIT $2 OFFSET $3`,
      values,
    );
    const countRows = await queryAdmin<CountRow>(
      `SELECT count(*)::int AS total
       FROM public.loans l
       WHERE ($1::text IS NULL OR l.status = $1)`,
      [status || null],
    );
    const total = countRows[0]?.total ?? 0;

    return json(200, {
      items: rows.map((row) => ({
        loanId: row.loan_id,
        requestId: row.request_id,
        requestCode: row.request_code,
        reservationId: row.reservation_id,
        exchangeId: row.exchange_id,
        copyId: row.copy_id,
        inventoryCode: row.inventory_code,
        title: row.title,
        author: row.author,
        status: row.status,
        startedAt: row.started_at,
        dueAt: row.due_at,
        closedAt: row.closed_at,
        deliveries: {
          dropoffDeliveryId: row.dropoff_delivery_id,
          handoverDeliveryId: row.handover_delivery_id,
          returnDeliveryId: row.return_delivery_id,
        },
      })),
      pagination: {
        page,
        pageSize,
        total,
        hasMore: page * pageSize < total,
      },
    });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/loans" };
