import { query } from "../lib/database.ts";
import { sha256 } from "../lib/crypto.ts";
import { clientAddress } from "../lib/login-rate-limit.ts";
import { publicRateLimitResponse } from "../lib/public-rate-limit.ts";
import {
  ApiError,
  json,
  mapError,
  methodNotAllowed,
  readJson,
  stringField,
} from "../lib/http.ts";

interface PublicStatusRow {
  request_code: string;
  status: string;
  created_at: string;
  offered_title: string | null;
  offered_author: string | null;
  requested_title: string | null;
  requested_author: string | null;
  requested_inventory_code: string | null;
  reservation_status: string | null;
  reservation_expires_at: string | null;
  exchange_status: string | null;
  exchange_completed_at: string | null;
  reception_status: string | null;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,200}$/;
const IP_LIMIT = 30;
const TOKEN_LIMIT = 10;
const WINDOW_SECONDS = 3600;
const RESERVATION_LABEL: Record<string, string> = {
  active: "Reservado temporalmente",
  converted: "Asignado / comprometido",
  expired: "Reserva vencida",
  released: "Reserva liberada",
};

function nextStep(row: PublicStatusRow): string {
  if (row.status === "completed") {
    return row.exchange_completed_at
      ? "El intercambio fue completado y confirmado."
      : "La solicitud figura completada. El equipo confirmará los detalles de la entrega.";
  }
  if (row.status === "rejected") {
    return "La solicitud fue rechazada. Puedes elegir otro libro del catálogo.";
  }
  if (row.status === "cancelled") {
    return "La solicitud fue cancelada. El ejemplar quedó liberado; puedes elegir otro libro.";
  }
  if (row.status === "approved") {
    if (row.reservation_status === "converted") {
      return "La solicitud fue aprobada y el ejemplar está asignado. El equipo coordinará la entrega; todavía no se ha completado el intercambio.";
    }
    if (row.reservation_status === "expired" || row.reservation_status === "released") {
      return "La solicitud fue aprobada, pero la reserva del ejemplar venció o fue liberada. El equipo revisará el caso.";
    }
    return "La solicitud fue aprobada. El equipo coordinará la entrega; todavía no se ha completado el intercambio.";
  }
  if (row.status === "scheduled" || row.status === "in_process") {
    return "El intercambio está en proceso. El equipo coordinará la entrega y su confirmación.";
  }
  if (row.status === "under_review") {
    return row.reservation_status === "active"
      ? "La solicitud está en revisión. El ejemplar está reservado temporalmente."
      : "La solicitud está en revisión.";
  }
  if (row.status === "pending") {
    return "La solicitud fue recibida y está pendiente de revisión.";
  }
  return "Consulta con el equipo institucional para conocer los próximos pasos.";
}

async function consumeBucket(
  scope: string,
  value: string,
  limit: number,
): Promise<Response | null> {
  const bucket = sha256(Buffer.from(`iub:status:${scope}:${value}`, "utf8"));
  const rows = await query<{ allowed: boolean; retry_after_seconds: number }>(
    "SELECT * FROM public.consume_public_status_rate_limit($1, $2, $3)",
    [bucket, limit, WINDOW_SECONDS],
  );
  const decision = rows[0];
  if (!decision) {
    throw new ApiError(503, "rate_limit_unavailable", "No se pudo validar el límite de consultas.");
  }
  if (decision.allowed) return null;
  return publicRateLimitResponse({
    allowed: false,
    retryAfterSeconds: decision.retry_after_seconds,
  });
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();

  try {
    const body = await readJson(request);
    const token = stringField(body, "token", { min: 32, max: 200 });
    if (!token || !TOKEN_PATTERN.test(token)) {
      throw new ApiError(400, "invalid_token", "El código de consulta no tiene un formato válido.");
    }

    const ipLimited = await consumeBucket("ip", clientAddress(request), IP_LIMIT);
    if (ipLimited) return ipLimited;

    const tokenHash = sha256(Buffer.from(token, "utf8"));
    const tokenLimited = await consumeBucket(
      "token",
      tokenHash.toString("hex"),
      TOKEN_LIMIT,
    );
    if (tokenLimited) return tokenLimited;

    const rows = await query<PublicStatusRow>(
      "SELECT * FROM public.get_public_request_status_by_token($1)",
      [tokenHash],
    );

    // Keep successful and not-found responses close in time.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const row = rows[0];
    if (!row) {
      throw new ApiError(
        404,
        "not_found",
        "No encontramos una solicitud con ese código. Verifica los datos e inténtalo nuevamente.",
      );
    }

    const requestedTitle = row.requested_title ?? "No registrado";
    return json(
      200,
      {
        requestCode: row.request_code,
        status: row.status,
        createdAt: row.created_at,
        copyTitle: requestedTitle,
        requestedTitle,
        requestedAuthor: row.requested_author,
        requestedInventoryCode: row.requested_inventory_code,
        offeredTitle: row.offered_title,
        offeredAuthor: row.offered_author,
        reservationStatus: row.reservation_status,
        reservationLabel: row.reservation_status
          ? RESERVATION_LABEL[row.reservation_status] ?? row.reservation_status
          : "Sin reserva",
        reservationExpiresAt: row.reservation_expires_at,
        exchangeStatus: row.exchange_status,
        exchangeCompletedAt: row.exchange_completed_at,
        receptionStatus: row.reception_status,
        nextStep: nextStep(row),
      },
      { "Cache-Control": "private, no-store, max-age=0" },
    );
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/requests/status" };
