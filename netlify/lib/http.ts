import {
  DatabaseQueryError,
  DatabaseUnavailableError,
} from "./database.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const responseHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...responseHeaders, ...headers },
  });
}

export function noContent(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers: { ...responseHeaders, ...headers } });
}

export function methodNotAllowed(): Response {
  return json(405, { error: { code: "method_not_allowed", message: "Método no permitido." } });
}

export async function readJson(request: Request, maxBytes = 64_000): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "Se requiere JSON.");
  }

  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > maxBytes) {
    throw new ApiError(413, "payload_too_large", "La solicitud es demasiado grande.");
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ApiError(400, "invalid_json", "El cuerpo JSON no es válido.");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, "invalid_body", "El cuerpo debe ser un objeto.");
  }
  return parsed as Record<string, unknown>;
}

export function stringField(
  body: Record<string, unknown>,
  key: string,
  { min = 1, max = 500, required = true }: { min?: number; max?: number; required?: boolean } = {},
): string | null {
  const value = body[key];
  if (value === undefined || value === null || value === "") {
    if (!required) return null;
    throw new ApiError(400, "missing_field", `Falta el campo ${key}.`);
  }
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_field", `El campo ${key} no es válido.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new ApiError(400, "invalid_field", `El campo ${key} no es válido.`);
  }
  return trimmed;
}

export function optionalStringField(
  body: Record<string, unknown>,
  key: string,
  max = 500,
): string | null {
  return stringField(body, key, { min: 0, max, required: false });
}

export function booleanField(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") {
    throw new ApiError(400, "invalid_field", `El campo ${key} no es válido.`);
  }
  return value;
}

export function numberField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
    throw new ApiError(400, "invalid_field", `El campo ${key} no es válido.`);
  }
  return number;
}

export function uuidField(body: Record<string, unknown>, key: string): string {
  const value = stringField(body, key, { min: 36, max: 36 });
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? "")
  ) {
    throw new ApiError(400, "invalid_field", `El campo ${key} no es válido.`);
  }
  return value as string;
}

export function oneOfField<T extends string>(
  body: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = stringField(body, key, { max: 80 });
  if (!value || !allowed.includes(value as T)) {
    throw new ApiError(400, "invalid_field", `El campo ${key} no es válido.`);
  }
  return value as T;
}

export function mapError(error: unknown): Response {
  if (error instanceof ApiError) {
    return json(error.status, { error: { code: error.code, message: error.message } });
  }
  if (error instanceof DatabaseUnavailableError) {
    return json(503, {
      error: { code: "database_unavailable", message: "El servicio no está disponible. Inténtalo más tarde." },
    });
  }
  if (error instanceof DatabaseQueryError) {
    switch (error.sqlState) {
      case "23514":
        return json(409, {
          error: { code: "invalid_state", message: "La operación no es válida en el estado actual." },
        });
      case "23505":
        return json(409, {
          error: { code: "conflict", message: "La operación entra en conflicto con otra existente." },
        });
      case "23502":
        return json(400, {
          error: { code: "missing_data", message: "Faltan datos obligatorios." },
        });
      case "28000":
        return json(401, {
          error: { code: "admin_session_invalid", message: "La sesión administrativa ya no es válida." },
        });
      case "42501":
        return json(403, {
          error: { code: "forbidden", message: "No tienes permiso para realizar esta operación." },
        });
      case "P0002":
        return json(404, {
          error: { code: "not_found", message: "No se encontró el registro solicitado." },
        });
      case "55000":
        return json(409, {
          error: {
            code: "prerequisite_pending",
            message: "Falta un paso previo, como confirmar la devolución física.",
          },
        });
      case "P0004":
        return json(409, {
          error: {
            code: "reservation_unavailable",
            message: "La reserva del ejemplar venció o no está vigente. No se puede aprobar; rechaza la solicitud o pide al estudiante elegir otro ejemplar.",
          },
        });
      case "P0005":
        return json(409, {
          error: {
            code: "copy_unavailable",
            message: "Este ejemplar ya no está disponible. Puedes elegir otro libro del catálogo.",
          },
        });
      case "22023":
      case "22P02":
        return json(400, {
          error: { code: "invalid_data", message: "Los datos enviados no son válidos." },
        });
      case "40001":
      case "40P01":
        return json(409, {
          error: { code: "retry", message: "La operación coincidió con otra; inténtalo de nuevo." },
        });
      default:
        break;
    }
  }
  return json(500, {
    error: { code: "internal_error", message: "No se pudo completar la operación." },
  });
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new ApiError(403, "forbidden_origin", "Origen no autorizado.");
  }
  if (request.headers.get("x-iub-admin") !== "1") {
    throw new ApiError(403, "missing_request_marker", "Solicitud administrativa no válida.");
  }
}
