-- DEPRECATED / DISABLED EVENT IMPORTER
--
-- This file was the one-off importer used for evento-2026-10-30. It contained a
-- destructive UPDATE that demoted IUB-REC-R-1793222267404 after its exchange
-- had completed. That UPDATE was removed on 2026-10-31.
--
-- Do not re-run this file. The supported path is:
--   1. db/migrations/0020_inventory_integrity_repair.sql
--   2. scripts/import-event-inventory.mjs
--   3. public.import_event_inventory(...)
--
-- The new importer never updates existing copies, inserts new copies as
-- unavailable, records movements and audit events, and is idempotent.
--
-- This block fails closed even if psql is invoked without ON_ERROR_STOP.

DO $deprecated_importer$
BEGIN
  RAISE EXCEPTION
    'Deprecated event importer. Use scripts/import-event-inventory.mjs and public.import_event_inventory(...).';
END
$deprecated_importer$;
