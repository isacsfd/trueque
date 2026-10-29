import { requireAdmin } from "../lib/auth.ts";
import { requireAdminPermission } from "../lib/admin-permissions.ts";
import { queryAdmin } from "../lib/database.ts";
import { ApiError, json, mapError, methodNotAllowed } from "../lib/http.ts";

interface CountRow {
  key: string;
  count: number;
}

function objectFrom(rows: CountRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.key, Number(row.count)]));
}

function numericRecord(record: Record<string, unknown> | undefined): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record ?? {}).map(([key, value]) => [key, Number(value ?? 0)]),
  );
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();

  try {
    const session = requireAdmin(request);
    await requireAdminPermission(session.actorUserId, "stats.read");

    const url = new URL(request.url);
    const rawMonths = url.searchParams.get("months");
    const months = rawMonths === null ? 6 : Number(rawMonths);
    if (!Number.isSafeInteger(months) || months < 1 || months > 12) {
      throw new ApiError(400, "invalid_field", "El rango temporal debe estar entre 1 y 12 meses.");
    }

    const [
      copies,
      catalog,
      requests,
      submissions,
      receptions,
      evaluations,
      admissions,
      exchanges,
      batches,
      legacy,
      requestTrend,
      batchTrend,
      completedExchangeTrend,
    ] = await Promise.all([
      queryAdmin<Record<string, number>>(
        `SELECT
           count(*) AS total_copies,
           count(*) FILTER (WHERE provenance_type = 'institutional') AS institutional_total,
           count(*) FILTER (WHERE provenance_type = 'institutional' AND availability = 'available') AS available,
           count(*) FILTER (WHERE provenance_type = 'institutional' AND availability = 'unavailable') AS unavailable,
           count(*) FILTER (WHERE provenance_type = 'institutional' AND availability = 'reserved') AS reserved,
           count(*) FILTER (WHERE provenance_type = 'institutional' AND availability = 'maintenance') AS maintenance,
           count(*) FILTER (WHERE provenance_type = 'institutional' AND availability = 'retired') AS retired,
           count(*) FILTER (WHERE provenance_type = 'institutional' AND verified_at IS NOT NULL) AS verified,
           count(*) FILTER (WHERE provenance_type = 'institutional' AND verified_at IS NULL) AS unverified,
           count(*) FILTER (WHERE provenance_type = 'institutional' AND physical_condition = 'unassessed') AS unassessed
         FROM public.copies`,
      ),
      queryAdmin<{ count: number }>("SELECT count(*)::int AS count FROM public.available_catalog"),
      queryAdmin<CountRow>("SELECT status AS key, count(*)::int AS count FROM public.exchange_requests GROUP BY status"),
      queryAdmin<CountRow>("SELECT status AS key, count(*)::int AS count FROM public.offered_book_submissions GROUP BY status"),
      queryAdmin<CountRow>("SELECT status AS key, count(*)::int AS count FROM public.receptions GROUP BY status"),
      queryAdmin<CountRow>("SELECT outcome AS key, count(*)::int AS count FROM public.book_evaluations GROUP BY outcome"),
      queryAdmin<CountRow>("SELECT status AS key, count(*)::int AS count FROM public.inventory_admissions GROUP BY status"),
      queryAdmin<CountRow>("SELECT status AS key, count(*)::int AS count FROM public.exchanges GROUP BY status"),
      queryAdmin<Record<string, number>>(
        `SELECT
           count(*) AS total,
           count(*) FILTER (WHERE status = 'prevalidated') AS prevalidated,
           count(*) FILTER (WHERE status = 'confirmed') AS confirmed,
           count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
           coalesce(sum(total_rows), 0)::int AS processed_rows,
           coalesce(sum(inserted_rows), 0)::int AS inserted_rows,
           coalesce(sum(reused_rows), 0)::int AS reused_rows,
           coalesce(sum(rejected_rows), 0)::int AS rejected_rows,
           coalesce(sum(duplicate_rows), 0)::int AS duplicate_rows
         FROM public.inventory_batches`,
      ),
      queryAdmin<Record<string, number>>(
        `SELECT count(*) AS batches,
                coalesce(sum(total_rows), 0)::int AS processed_rows,
                coalesce(sum(rejected_rows), 0)::int AS rejected_rows
         FROM public.inventory_import_batches`,
      ),
      queryAdmin<{ period: string; count: number }>(
        `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS period,
                count(*)::int AS count
         FROM public.exchange_requests
         WHERE created_at >= date_trunc('month', now()) - make_interval(months => $1::int - 1)
         GROUP BY date_trunc('month', created_at)
         ORDER BY date_trunc('month', created_at)`,
        [months],
      ),
      queryAdmin<{ period: string; count: number }>(
        `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS period,
                count(*)::int AS count
         FROM public.inventory_batches
         WHERE created_at >= date_trunc('month', now()) - make_interval(months => $1::int - 1)
         GROUP BY date_trunc('month', created_at)
         ORDER BY date_trunc('month', created_at)`,
        [months],
      ),
      queryAdmin<{ period: string; count: number }>(
        `SELECT to_char(date_trunc('month', completed_at), 'YYYY-MM') AS period,
                count(*)::int AS count
         FROM public.exchanges
         WHERE status = 'completed'
           AND completed_at IS NOT NULL
           AND completed_at >= date_trunc('month', now()) - make_interval(months => $1::int - 1)
         GROUP BY date_trunc('month', completed_at)
         ORDER BY date_trunc('month', completed_at)`,
        [months],
      ),
    ]);

    const submissionCounts = objectFrom(submissions);
    return json(200, {
      range: { months },
      inventory: {
        totalCopies: Number(copies[0]?.total_copies ?? 0),
        institutionalTotal: Number(copies[0]?.institutional_total ?? 0),
        available: Number(copies[0]?.available ?? 0),
        unavailable: Number(copies[0]?.unavailable ?? 0),
        reserved: Number(copies[0]?.reserved ?? 0),
        maintenance: Number(copies[0]?.maintenance ?? 0),
        retired: Number(copies[0]?.retired ?? 0),
        verified: Number(copies[0]?.verified ?? 0),
        unverified: Number(copies[0]?.unverified ?? 0),
        unassessed: Number(copies[0]?.unassessed ?? 0),
        publicCatalog: Number(catalog[0]?.count ?? 0),
      },
      requests: objectFrom(requests),
      submissions: submissionCounts,
      offersInReview: (submissionCounts.pending_review ?? 0) + (submissionCounts.in_review ?? 0),
      receptions: objectFrom(receptions),
      evaluations: objectFrom(evaluations),
      admissions: objectFrom(admissions),
      exchanges: objectFrom(exchanges),
      batches: numericRecord(batches[0]),
      legacyImport: numericRecord(legacy[0]),
      trends: {
        months,
        requests: requestTrend,
        batches: batchTrend,
        completedExchanges: completedExchangeTrend,
      },
    });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/stats" };
