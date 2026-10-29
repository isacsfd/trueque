import {
  clearSessionCookie,
  hashPassword,
  requireAdmin,
  verifyLegacyAdminPassword,
  verifyPassword,
} from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { queryAdmin } from "../lib/database.ts";
import {
  ApiError,
  assertSameOrigin,
  json,
  mapError,
  methodNotAllowed,
  readJson,
  stringField,
} from "../lib/http.ts";

function validateNewPassword(password: string): void {
  if (password.length < 12 || password.length > 200) {
    throw new ApiError(400, "weak_password", "La nueva contraseña debe tener entre 12 y 200 caracteres.");
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    throw new ApiError(400, "weak_password", "Usa mayúsculas, minúsculas, un número y un símbolo.");
  }
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  try {
    assertSameOrigin(request);
    const session = requireAdmin(request);
    await assertActiveAdminActor(session.actorUserId, session.sessionVersion);
    const body = await readJson(request);
    const currentPassword = stringField(body, "currentPassword", { min: 1, max: 500 });
    const newPassword = stringField(body, "newPassword", { min: 12, max: 200 });
    const confirmPassword = stringField(body, "confirmPassword", { min: 12, max: 200 });
    if (!currentPassword || !newPassword || !confirmPassword) {
      throw new ApiError(400, "invalid_field", "Completa todos los campos.");
    }
    if (newPassword !== confirmPassword) {
      throw new ApiError(400, "password_mismatch", "La confirmación no coincide con la nueva contraseña.");
    }
    if (newPassword === currentPassword) {
      throw new ApiError(400, "password_reused", "La nueva contraseña debe ser diferente de la actual.");
    }
    validateNewPassword(newPassword);

    const credentials = await queryAdmin<{ password_hash: string }>(
      "SELECT password_hash FROM public.admin_credentials WHERE user_id = $1",
      [session.actorUserId],
    );
    const currentIsValid = credentials[0]
      ? verifyPassword(currentPassword, credentials[0].password_hash)
      : verifyLegacyAdminPassword(session.username, currentPassword);
    if (!currentIsValid) {
      throw new ApiError(401, "invalid_credentials", "La contraseña actual no es correcta.");
    }

    await queryAdmin(
      "SELECT public.admin_change_own_password_named($1, $2, $3)",
      [session.actorUserId, hashPassword(newPassword), session.username],
    );
    return json(
      200,
      { ok: true, reauth: true, message: "Contraseña actualizada. Inicia sesión nuevamente." },
      { "Set-Cookie": clearSessionCookie() },
    );
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/change-password" };
