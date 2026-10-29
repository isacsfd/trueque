import { requireAdmin } from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { queryAdmin } from "../lib/database.ts";
import { ApiError, json, mapError, methodNotAllowed } from "../lib/http.ts";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  try {
    const session = requireAdmin(request);
    await assertActiveAdminActor(session.actorUserId, session.sessionVersion);
    const allowed = await queryAdmin<{ allowed: boolean }>(
      "SELECT public.admin_has_account_manage($1) AS allowed",
      [session.actorUserId],
    );
    if (allowed[0]?.allowed !== true) {
      throw new ApiError(403, "forbidden", "No tienes permiso para consultar la auditoría administrativa.");
    }
    const rows = await queryAdmin<{
      id: string;
      actor_user_id: string | null;
      actor_subject: string | null;
      event_type: string;
      resource_type: string;
      resource_id: string;
      metadata: unknown;
      occurred_at: string;
    }>(
      `SELECT a.id, a.actor_user_id::text, u.identity_subject AS actor_subject,
              a.event_type, a.resource_type, a.resource_id, a.metadata, a.occurred_at
       FROM public.audit_events a
       LEFT JOIN public.app_users u ON u.id = a.actor_user_id
       WHERE a.event_type LIKE 'account.%'
          OR a.event_type = 'admin_credentials.login'
       ORDER BY a.occurred_at DESC, a.id DESC
       LIMIT 100`,
    );
    return json(200, { items: rows });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/audit" };
