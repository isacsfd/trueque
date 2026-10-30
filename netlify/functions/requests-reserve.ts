import { DatabaseQueryError, query } from "../lib/database.ts";
import { sha256 } from "../lib/crypto.ts";
import { enforcePublicRateLimit } from "../lib/public-rate-limit.ts";
import {
  ApiError,
  json,
  mapError,
  methodNotAllowed,
  numberField,
  readJson,
  stringField,
  uuidField,
} from "../lib/http.ts";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();

  try {
    const limited = enforcePublicRateLimit(request, "requests-reserve", 60, 3600);
    if (limited) return limited;
    const body = await readJson(request);
    const requestId = numberField(body, "requestId");
    const copyId = numberField(body, "copyId");
    const accessToken = stringField(body, "accessToken", { min: 32, max: 200 });
    const idempotencyKey = uuidField(body, "idempotencyKey");
    const accessHash = sha256(Buffer.from(accessToken ?? "", "utf8"));

    try {
      const rows = await query<{ reservation_id: string; expires_at: string }>(
        "SELECT * FROM public.reserve_copy($1, $2, $3, $4)",
        [copyId, requestId, accessHash, idempotencyKey],
      );
      const row = rows[0];
      if (!row) throw new ApiError(503, "reservation_failed", "No se pudo reservar el ejemplar.");
      return json(201, { reservationId: row.reservation_id, expiresAt: row.expires_at });
    } catch (error) {
      if (error instanceof DatabaseQueryError && (error.sqlState === "P0005" || error.sqlState === "23514")) {
        throw new ApiError(
          409,
          "copy_unavailable",
          "Este ejemplar ya no está disponible. Puedes elegir otro libro del catálogo.",
        );
      }
      if (error instanceof DatabaseQueryError && error.sqlState === "P0004") {
        throw new ApiError(
          409,
          "reservation_unavailable",
          "La reserva de este ejemplar venció. Vuelve a elegir un libro disponible.",
        );
      }
      if (error instanceof DatabaseQueryError && error.sqlState === "42501") {
        throw new ApiError(403, "invalid_proof", "No se pudo validar la solicitud.");
      }
      throw error;
    }
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/requests/reserve" };
