-- Fourteenth versioned migration. Runtime grants required by the administrative
-- inventory and request workbenches.
--
-- The deployed staging database had the routines created by earlier migrations
-- but the runtime role was missing EXECUTE on assert_actor_permission. That
-- made admin-batches list/confirm/cancel return 403 even for SUPER ADMIN.
-- GRANT is idempotent and does not change any data.

GRANT EXECUTE ON FUNCTION public.assert_actor_permission(BIGINT, TEXT)
  TO iub_admin_runtime;
