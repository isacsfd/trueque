-- Emergency rollback for 0020_inventory_integrity_repair.sql.
--
-- This is NOT a data rollback. It restores the pre-0020 catalogue view and
-- removes the new guards/functions so the previous application behaviour can
-- be resumed. It deliberately keeps the new columns and tables so synthetic
-- classification, exemptions and import history are not destroyed. They become
-- inert until a forward fix is applied.
--
-- Use only with explicit approval and a verified backup.

BEGIN;

DROP VIEW IF EXISTS public.inventory_anomaly_counts;
DROP VIEW IF EXISTS public.real_inventory_anomalies;
DROP VIEW IF EXISTS public.inventory_anomalies;
DROP VIEW IF EXISTS public.institutional_verification_backlog;

CREATE OR REPLACE VIEW public.available_catalog WITH (security_barrier = TRUE) AS
SELECT
  c.id AS copy_id,
  b.id AS bibliographic_record_id,
  b.title,
  b.author,
  b.isbn,
  b.edition,
  b.publication_year,
  p.name AS publisher,
  g.name AS genre,
  c.inventory_code,
  c.physical_condition,
  c.location
FROM public.copies c
JOIN public.bibliographic_records b ON b.id = c.bibliographic_record_id
LEFT JOIN public.publishers p ON p.id = b.publisher_id
LEFT JOIN public.genres g ON g.id = b.genre_id
WHERE c.availability = 'available';

REVOKE ALL ON public.available_catalog FROM PUBLIC, iub_admin_runtime;
GRANT SELECT ON public.available_catalog TO iub_public_runtime;

DROP TRIGGER IF EXISTS exchange_requests_institutional_eligibility_guard
  ON public.exchange_requests;
DROP TRIGGER IF EXISTS copies_availability_transition_guard ON public.copies;
DROP TRIGGER IF EXISTS copies_institutional_eligibility_guard ON public.copies;

DROP FUNCTION IF EXISTS public.guard_institutional_request_copy();
DROP FUNCTION IF EXISTS public.guard_copy_availability_transition();
DROP FUNCTION IF EXISTS public.guard_institutional_copy_eligibility();
DROP FUNCTION IF EXISTS public.copy_is_synthetic(BIGINT);
DROP FUNCTION IF EXISTS public.verify_institutional_copy(BIGINT, BIGINT, TEXT);
DROP FUNCTION IF EXISTS public.publish_institutional_copy(BIGINT, BIGINT, UUID);
DROP FUNCTION IF EXISTS public.withdraw_copy(BIGINT, TEXT, TEXT, BIGINT, UUID);
DROP FUNCTION IF EXISTS public.classify_synthetic_inventory(BIGINT);
DROP FUNCTION IF EXISTS public.import_event_inventory(TEXT, JSONB, BIGINT, UUID);

-- Keep these objects intentionally:
--   copies.verified_at / verified_by / verification_reference / is_synthetic
--   catalog_verification_exemptions
--   inventory_event_imports / inventory_event_import_bibs
-- Dropping them would lose audit/classification evidence. A forward migration
-- should be preferred over destructive cleanup.

COMMIT;
