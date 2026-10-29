import {
  clearSessionCookie,
  loginAdmin,
  readAdminSession,
} from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import {
  checkLoginRateLimit,
  clearLoginFailures,
  clientAddress,
  recordLoginFailure,
} from "../lib/login-rate-limit.ts";
import {
  ApiError,
  assertSameOrigin,
  json,
  mapError,
  methodNotAllowed,
  noContent,
  readJson,
  stringField,
} from "../lib/http.ts";

export default async function handler(request: Request): Promise<Response> {
  try {
    if (request.method === "POST") {
      const origin = request.headers.get("origin");
      if (origin && origin !== new URL(request.url).origin) {
        throw new ApiError(403, "forbidden_origin", "Origen no autorizado.");
      }
      const body = await readJson(request);
      const username = stringField(body, "username", { max: 120 });
      const password = stringField(body, "password", { min: 8, max: 500 });
      const address = clientAddress(request);
      const limit = checkLoginRateLimit(username ?? "", address);
      if (!limit.allowed) {
        return json(
          429,
          {
            error: {
              code: "too_many_attempts",
              message: "Demasiados intentos. Espera antes de volver a intentarlo.",
            },
          },
          { "Retry-After": String(limit.retryAfterSeconds) },
        );
      }

      try {
        const { session, cookie } = await loginAdmin(
          username ?? "",
          password ?? "",
          new URL(request.url).protocol === "https:",
        );
        try {
          await assertActiveAdminActor(session.actorUserId, session.sessionVersion);
        } catch (error) {
          if (error instanceof ApiError && error.code === "admin_session_invalid") {
            throw new ApiError(401, "invalid_credentials", "Usuario o contraseña incorrectos.");
          }
          throw error;
        }
        clearLoginFailures(username ?? "", address);
        return json(200, { username: session.username }, { "Set-Cookie": cookie });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          recordLoginFailure(username ?? "", address);
        }
        throw error;
      }
    }

    if (request.method === "GET") {
      const session = readAdminSession(request);
      if (!session) throw new ApiError(401, "unauthorized", "Inicia sesión para continuar.");
      await assertActiveAdminActor(session.actorUserId, session.sessionVersion);
      return json(200, { username: session.username });
    }

    if (request.method === "DELETE") {
      assertSameOrigin(request);
      return noContent({ "Set-Cookie": clearSessionCookie() });
    }

    return methodNotAllowed();
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/session" };
