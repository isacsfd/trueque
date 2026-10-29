import { requireAdmin } from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { requireAdminPermission } from "../lib/admin-permissions.ts";
import { queryAdmin } from "../lib/database.ts";
import {
  assertSameOrigin,
  booleanField,
  json,
  mapError,
  methodNotAllowed,
  numberField,
  oneOfField,
  optionalStringField,
  readJson,
  stringField,
} from "../lib/http.ts";

interface AccountRow {
  user_id: string;
  identity_issuer: string | null;
  identity_subject: string;
  email: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  roles: Array<{
    roleId: string;
    roleKey: string;
    displayName: string;
    description: string | null;
  }>;
  permissions: string[];
}

interface RoleRow {
  id: string;
  role_key: string;
  display_name: string;
  description: string | null;
}

interface RolePermissionRow {
  role_id: string;
  permission_key: string;
}

interface PermissionRow {
  permission_key: string;
  description: string;
}

const actions = ["create", "set_active", "assign_role", "remove_role"] as const;

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed();

  try {
    if (request.method === "POST") assertSameOrigin(request);
    const session = requireAdmin(request);
    await assertActiveAdminActor(session.actorUserId, session.sessionVersion);
    await requireAdminPermission(session.actorUserId, "account.manage");

    if (request.method === "POST") {
      const body = await readJson(request);
      const action = oneOfField(body, "action", actions);

      if (action === "create") {
        const identityIssuer = optionalStringField(body, "identityIssuer", 250) ?? "local";
        const identitySubject = stringField(body, "identitySubject", { min: 3, max: 200 });
        const email = optionalStringField(body, "email", 320);
        await queryAdmin(
          "SELECT public.admin_create_account($1, $2, $3, $4)",
          [session.actorUserId, identityIssuer, identitySubject, email],
        );
        return json(200, {
          ok: true,
          loginNote:
            "El actor de base fue creado. El inicio de sesión debe configurarse en ADMIN_USERS o en el proveedor OIDC; Trueque no almacena contraseñas.",
        });
      }

      const userId = numberField(body, "userId");
      if (action === "set_active") {
        const active = booleanField(body, "active");
        await queryAdmin("SELECT public.admin_set_account_active($1, $2, $3)", [
          session.actorUserId,
          userId,
          active,
        ]);
      } else {
        const roleId = numberField(body, "roleId");
        const routine = action === "assign_role" ? "admin_assign_role" : "admin_remove_role";
        await queryAdmin(`SELECT public.${routine}($1, $2, $3)`, [
          session.actorUserId,
          userId,
          roleId,
        ]);
      }
      return json(200, { ok: true });
    }

    const [accounts, roles, rolePermissions, permissions] = await Promise.all([
      queryAdmin<AccountRow>("SELECT * FROM public.admin_list_accounts($1)", [session.actorUserId]),
      queryAdmin<RoleRow>(
        "SELECT id, role_key, display_name, description FROM public.roles ORDER BY role_key",
      ),
      queryAdmin<RolePermissionRow>(
        `SELECT rp.role_id, p.permission_key
         FROM public.role_permissions rp
         JOIN public.permissions p ON p.id = rp.permission_id
         ORDER BY p.permission_key`,
      ),
      queryAdmin<PermissionRow>(
        "SELECT permission_key, description FROM public.permissions ORDER BY permission_key",
      ),
    ]);

    const permissionsByRole = new Map<string, string[]>();
    for (const row of rolePermissions) {
      const list = permissionsByRole.get(row.role_id) ?? [];
      list.push(row.permission_key);
      permissionsByRole.set(row.role_id, list);
    }

    return json(200, {
      currentActorUserId: String(session.actorUserId),
      accounts: accounts.map((row) => ({
        userId: String(row.user_id),
        identityIssuer: row.identity_issuer,
        identitySubject: row.identity_subject,
        email: row.email,
        isActive: row.is_active,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        roles: row.roles ?? [],
        permissions: row.permissions ?? [],
      })),
      roles: roles.map((row) => ({
        roleId: String(row.id),
        roleKey: row.role_key,
        displayName: row.display_name,
        description: row.description,
        permissions: permissionsByRole.get(String(row.id)) ?? [],
      })),
      permissions: permissions.map((row) => ({
        key: row.permission_key,
        description: row.description,
      })),
    });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/accounts" };
