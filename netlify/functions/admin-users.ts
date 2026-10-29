import { randomBytes } from "node:crypto";
import { requireAdmin, hashPassword } from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { queryAdmin } from "../lib/database.ts";
import {
  ApiError,
  assertSameOrigin,
  booleanField,
  json,
  mapError,
  methodNotAllowed,
  numberField,
  oneOfField,
  readJson,
  stringField,
} from "../lib/http.ts";

const actions = ["create", "set_active", "assign_role", "remove_role", "reset_password"] as const;
const roleKeys = ["super_admin", "administrator", "reviewer", "exchange_operator", "read_only"] as const;

async function requireAccountManage(actorUserId: number): Promise<void> {
  const rows = await queryAdmin<{ allowed: boolean }>(
    "SELECT public.admin_has_account_manage($1) AS allowed",
    [actorUserId],
  );
  if (rows[0]?.allowed !== true) {
    throw new ApiError(403, "forbidden", "No tienes permiso para gestionar cuentas.");
  }
}

function temporaryPassword(): string {
  return randomBytes(18).toString("base64url");
}

async function listUsers(currentActorUserId: number) {
  const users = await queryAdmin<{
    user_id: number;
    login_name: string;
    identity_subject: string;
    email: string | null;
    is_active: boolean;
    created_at: string;
    last_login_at: string | null;
    must_change_password: boolean | null;
    has_password: boolean;
    roles: Array<{ roleKey: string; displayName: string }>;
  }>(
    `SELECT u.id AS user_id,
            COALESCE(c.login_name, u.identity_subject) AS login_name,
            u.identity_subject, u.email, u.is_active, u.created_at,
            c.last_login_at, c.must_change_password, (c.user_id IS NOT NULL) AS has_password,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object('roleKey', r.role_key, 'displayName', r.display_name) ORDER BY r.role_key)
              FROM public.user_roles ur
              JOIN public.roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id
            ), '[]'::jsonb) AS roles
     FROM public.app_users u
     LEFT JOIN public.admin_credentials c ON c.user_id = u.id
     ORDER BY u.id`,
  );
  const roles = await queryAdmin<{
    role_id: number;
    role_key: string;
    display_name: string;
    description: string | null;
  }>("SELECT id AS role_id, role_key, display_name, description FROM public.roles ORDER BY role_key");
  return { currentActorUserId, users, roles };
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed();
  try {
    if (request.method === "POST") assertSameOrigin(request);
    const session = requireAdmin(request);
    await assertActiveAdminActor(session.actorUserId, session.sessionVersion);
    await requireAccountManage(session.actorUserId);

    if (request.method === "GET") {
      return json(200, await listUsers(session.actorUserId));
    }

    const body = await readJson(request);
    const action = oneOfField(body, "action", actions);

    if (action === "create") {
      const email = stringField(body, "email", { max: 320 })?.toLowerCase();
      if (!email) throw new ApiError(400, "invalid_field", "El correo es obligatorio.");
      const loginName = stringField(body, "loginName", { min: 3, max: 200 })?.toLowerCase() || email;
      const roleKey = oneOfField(body, "roleKey", roleKeys);
      const password = temporaryPassword();
      const rows = await queryAdmin<{ admin_create_user: number }>(
        "SELECT public.admin_create_user($1, $2, $3, $4, $5) AS admin_create_user",
        [session.actorUserId, loginName, email, hashPassword(password), roleKey],
      );
      return json(201, {
        ok: true,
        userId: rows[0]?.admin_create_user,
        temporaryPassword: password,
        mustChangePassword: true,
      });
    }

    const userId = numberField(body, "userId");

    if (action === "set_active") {
      const active = booleanField(body, "active");
      await queryAdmin("SELECT public.admin_set_user_active($1, $2, $3)", [session.actorUserId, userId, active]);
      return json(200, { ok: true });
    }

    if (action === "assign_role" || action === "remove_role") {
      const roleKey = oneOfField(body, "roleKey", roleKeys);
      const routine = action === "assign_role" ? "admin_assign_user_role" : "admin_remove_user_role";
      await queryAdmin(`SELECT public.${routine}($1, $2, $3)`, [session.actorUserId, userId, roleKey]);
      return json(200, { ok: true });
    }

    const target = await queryAdmin<{ login_name: string }>(
      `SELECT COALESCE(c.login_name, u.identity_subject) AS login_name
       FROM public.app_users u
       LEFT JOIN public.admin_credentials c ON c.user_id = u.id
       WHERE u.id = $1`,
      [userId],
    );
    if (!target[0]) throw new ApiError(404, "not_found", "No se encontró la cuenta.");
    const password = temporaryPassword();
    await queryAdmin(
      "SELECT public.admin_reset_user_password_named($1, $2, $3, $4)",
      [session.actorUserId, userId, hashPassword(password), target[0].login_name],
    );
    return json(200, {
      ok: true,
      temporaryPassword: password,
      mustChangePassword: true,
    });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/users" };
