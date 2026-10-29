import { query } from "../lib/database.ts";
import { sha256 } from "../lib/crypto.ts";
import { enforcePublicRateLimit } from "../lib/public-rate-limit.ts";
import {
  ApiError,
  json,
  mapError,
  methodNotAllowed,
  readJson,
  stringField,
} from "../lib/http.ts";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();

  try {
    const limited = enforcePublicRateLimit(request, "requests-status", 120, 3600);
    if (limited) return limited;
    const body = await readJson(request);
    const code = stringField(body, "code", { min: 4, max: 80 });
    const token = stringField(body, "token", { min: 32, max: 200 });
    const accessHash = sha256(Buffer.from(token ?? "", "utf8"));

    const rows = await query<{
      request_code: string;
      status: string;
      created_at: string;
      copy_title: string;
      exchange_status: string | null;
      reception_status: string | null;
      return_required: boolean;
      return_confirmed: boolean;
    }>("SELECT * FROM public.get_request_status($1, $2)", [code, accessHash]);
    const row = rows[0];
    if (!row) {
      throw new ApiError(404, "not_found", "No se encontró una solicitud con esos datos.");
    }

    return json(200, {
      requestCode: row.request_code,
      status: row.status,
      createdAt: row.created_at,
      copyTitle: row.copy_title,
      exchangeStatus: row.exchange_status,
      receptionStatus: row.reception_status,
      returnRequired: row.return_required,
      returnConfirmed: row.return_confirmed,
    });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/requests/status" };
