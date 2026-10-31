-- 2026-10-31: classify the known synthetic QA records.
--
-- Run only after 0020_inventory_integrity_repair.sql and only with an actor
-- holding inventory.classify_synthetic. This script does not change
-- availability, does not publish anything and does not delete rows.
--
-- Usage:
--   psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 \
--     -v actor_id=<ADMIN_USER_ID> \
--     -f db/repairs/2026-10-31_classify_synthetic_inventory.sql

\set ON_ERROR_STOP on

SELECT public.classify_synthetic_inventory(:actor_id) AS synthetic_records_classified;

SELECT
  copy_id,
  inventory_code,
  availability,
  is_synthetic
FROM public.copies
WHERE inventory_code IN ('IUB-STG-001', 'IUB-STG-002', 'IUB-REC-R-1793222267404')
ORDER BY inventory_code;
