-- 0021_admin_workbench_indexes.sql
--
-- Additive index for the administrative workbench. The legacy query sorts
-- exchange_requests by created_at DESC, id DESC and previously had only a
-- status-prefixed index, so PostgreSQL sorted the whole table before LIMIT.
--
-- This migration changes no data and creates no triggers. It is prepared for
-- separate production authorization; it is not applied by the 0020 hotfix.

CREATE INDEX IF NOT EXISTS exchange_requests_created_at_id_idx
  ON public.exchange_requests (created_at DESC, id DESC);

COMMENT ON INDEX public.exchange_requests_created_at_id_idx IS
  'Stable administrative workbench ordering without a full sort.';
