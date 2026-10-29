import { requireAdmin } from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { ApiError, assertSameOrigin, json, mapError, methodNotAllowed } from "../lib/http.ts";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed();

  try {
    if (request.method === "POST") assertSameOrigin(request);
    const session = requireAdmin(request);
    await assertActiveAdminActor(session.actorUserId, session.sessionVersion);

    if (request.method === "GET") {
      return json(200, {
        username: session.username,
        actorUserId: session.actorUserId,
        expiresAt: new Date(session.expiresAt * 1000).toISOString(),
        canChangePassword: false,
        passwordManagedBy: "environment",
        management:
          "La contraseña se administra en la configuración privada ADMIN_USERS/SESSION_SECRET del despliegue o mediante el proveedor OIDC institucional. Trueque no almacena contraseñas propias.",
      });
    }

    throw new ApiError(
      409,
      "password_managed_externally",
      "La contraseña no se gestiona en la base de datos de Trueque. Solicita la rotación al administrador de plataforma o usa el proveedor de identidad institucional cuando esté disponible.",
    );
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/account" };
