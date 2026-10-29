import { queryAdmin } from "./database.ts";

export async function requireAdminPermission(actorUserId: number, permission: string): Promise<void> {
  await queryAdmin("SELECT public.assert_actor_permission($1, $2)", [actorUserId, permission]);
}
