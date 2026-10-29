import { queryAdmin } from "./database.ts";
import { ApiError } from "./http.ts";

/**
 * Revalidates that the actor referenced by the signed session still exists and
 * is active. A cookie is only a transport for the actor id; it is not proof of
 * current administrative status.
 */
export async function assertActiveAdminActor(
  actorUserId: number,
  sessionVersion?: number,
): Promise<void> {
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
    throw new ApiError(401, "admin_session_invalid", "La sesión administrativa ya no es válida.");
  }

  const rows = await queryAdmin<{ is_active: boolean; session_version: number | null }>(
    `SELECT u.is_active, c.session_version
     FROM public.app_users u
     LEFT JOIN public.admin_credentials c ON c.user_id = u.id
     WHERE u.id = $1`,
    [actorUserId],
  );
  const row = rows[0];
  if (!row || row.is_active !== true) {
    throw new ApiError(401, "admin_session_invalid", "La sesión administrativa ya no es válida.");
  }
  if (row.session_version !== null && row.session_version !== sessionVersion) {
    throw new ApiError(401, "admin_session_invalid", "La sesión administrativa ya no es válida.");
  }
}
