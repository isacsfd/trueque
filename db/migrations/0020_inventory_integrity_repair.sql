-- 0020_inventory_integrity_repair.sql
--
-- Additive inventory-integrity hotfix for a production schema that is at the
-- 0001-0005 baseline plus selected manual objects. It is intentionally
-- self-contained: it does not depend on 0006-0019 and must not be applied by
-- the historical contiguous migration runner while those versions are absent.
--
-- Goals:
--   1. Preserve the current visibility of already-available institutional
--      copies through an explicit legacy exemption. Nothing is enabled or
--      hidden by this migration.
--   2. Require positive verification for new institutional copies.
--   3. Block uncontrolled availability downgrades, including the exact bulk
--      update that demoted a completed exchange copy.
--   4. Add audited, permissioned and idempotent verify/publish/withdraw/import
--      operations.
--   5. Expose anomaly views that separate synthetic QA records from real stock.
--
-- This file does not publish, retire, verify or classify any existing copy.

DO $precondition$
BEGIN
  IF to_regclass('public.copies') IS NULL
     OR to_regclass('public.bibliographic_records') IS NULL
     OR to_regclass('public.inventory_movements') IS NULL
     OR to_regclass('public.audit_events') IS NULL
     OR to_regclass('public.exchanges') IS NULL
     OR to_regclass('public.reservations') IS NULL
     OR to_regclass('public.available_catalog') IS NULL
     OR to_regclass('public.permissions') IS NULL
     OR to_regclass('public.app_users') IS NULL
     OR to_regprocedure('public.assert_actor_permission(bigint,text)') IS NULL THEN
    RAISE EXCEPTION
      '0020 requires the 0001-0005 inventory baseline; manual review required'
      USING ERRCODE = '55000';
  END IF;
END
$precondition$;

-- ---------------------------------------------------------------------------
-- 1. Verification metadata and synthetic-data classification flag
-- ---------------------------------------------------------------------------

ALTER TABLE public.copies
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_by BIGINT REFERENCES public.app_users(id),
  ADD COLUMN IF NOT EXISTS verification_reference TEXT,
  ADD COLUMN IF NOT EXISTS is_synthetic BOOLEAN NOT NULL DEFAULT FALSE;

DO $verification_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.copies'::regclass
      AND conname = 'copies_verification_ck'
  ) THEN
    ALTER TABLE public.copies
      ADD CONSTRAINT copies_verification_ck CHECK (
        (verified_at IS NULL AND verified_by IS NULL AND verification_reference IS NULL)
        OR (
          verified_at IS NOT NULL
          AND verified_by IS NOT NULL
          AND verification_reference IS NOT NULL
          AND length(btrim(verification_reference)) BETWEEN 1 AND 500
        )
      );
  END IF;
END
$verification_constraint$;

COMMENT ON COLUMN public.copies.verified_at IS
  'Positive institutional verification timestamp. NULL means not verified.';
COMMENT ON COLUMN public.copies.verified_by IS
  'Active administrative actor that approved the institutional verification.';
COMMENT ON COLUMN public.copies.verification_reference IS
  'Evidence reference for the institutional verification decision.';
COMMENT ON COLUMN public.copies.is_synthetic IS
  'True only for records explicitly classified as synthetic/QA. Never inferred automatically by this column.';

CREATE INDEX IF NOT EXISTS copies_institutional_unverified_idx
  ON public.copies (availability, id)
  WHERE provenance_type = 'institutional' AND verified_at IS NULL;

CREATE INDEX IF NOT EXISTS copies_synthetic_idx
  ON public.copies (id)
  WHERE is_synthetic;

-- ---------------------------------------------------------------------------
-- 2. Explicit legacy catalogue exemptions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.catalog_verification_exemptions (
  copy_id BIGINT PRIMARY KEY REFERENCES public.copies(id),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  exempted_by BIGINT REFERENCES public.app_users(id),
  exempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  review_due_at TIMESTAMPTZ,
  CHECK (review_due_at IS NULL OR review_due_at > exempted_at)
);

COMMENT ON TABLE public.catalog_verification_exemptions IS
  'Legacy catalogue visibility only. An exemption never verifies or publishes a copy and must not be used for new institutional stock.';

REVOKE ALL ON public.catalog_verification_exemptions
  FROM PUBLIC, iub_public_runtime;
GRANT SELECT ON public.catalog_verification_exemptions TO iub_admin_runtime;
-- available_catalog is owned by the historical schema migrator. The view
-- owner must be able to read the exemption table.
GRANT SELECT ON public.catalog_verification_exemptions TO iub_schema_migrator;

CREATE TABLE IF NOT EXISTS public.inventory_repair_markers (
  marker_key TEXT PRIMARY KEY CHECK (length(btrim(marker_key)) BETWEEN 1 AND 200),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(metadata) = 'object')
);

REVOKE ALL ON public.inventory_repair_markers
  FROM PUBLIC, iub_public_runtime;
GRANT SELECT ON public.inventory_repair_markers TO iub_admin_runtime;

-- Preserve exactly the copies that are already visible at the first
-- application. The one-time marker prevents a later re-run from grandfathering
-- copies that appeared after this migration.
DO $legacy_exemptions$
DECLARE
  v_inserted INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.inventory_repair_markers
    WHERE marker_key = '0020_legacy_exemptions_applied'
  ) THEN
    INSERT INTO public.catalog_verification_exemptions
      (copy_id, reason, review_due_at)
    SELECT
      c.id,
      'Legacy catalogue visibility or approved commitment preserved by 0020; individual verification pending',
      clock_timestamp() + INTERVAL '90 days'
    FROM public.copies c
    WHERE c.provenance_type = 'institutional'
      AND c.availability IN ('available', 'reserved')
      AND c.verified_at IS NULL
    ON CONFLICT (copy_id) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    INSERT INTO public.inventory_repair_markers (marker_key, metadata)
    VALUES (
      '0020_legacy_exemptions_applied',
      jsonb_build_object('copies_exempted', v_inserted, 'availability_changed', FALSE)
    )
    ON CONFLICT (marker_key) DO NOTHING;

    INSERT INTO public.audit_events
      (actor_user_id, event_type, resource_type, resource_id, metadata)
    VALUES
      (NULL,
       'inventory.legacy_catalog_exemptions_created',
       'inventory',
       '0020_inventory_integrity_repair',
       jsonb_build_object(
         'copies', v_inserted,
         'availability_changed', FALSE,
         'policy', 'preserve existing visibility; require verification for new stock'
       ));
  END IF;
END
$legacy_exemptions$;

-- ---------------------------------------------------------------------------
-- 3. New permissions
-- ---------------------------------------------------------------------------

INSERT INTO public.permissions (permission_key, description) VALUES
  ('inventory.verify', 'Verificar institucionalmente un ejemplar'),
  ('inventory.publish', 'Publicar un ejemplar institucional verificado'),
  ('inventory.withdraw', 'Retirar o cuarentenar un ejemplar con trazabilidad'),
  ('inventory.events.import', 'Importar inventario de eventos de forma idempotente'),
  ('inventory.classify_synthetic', 'Clasificar registros sintéticos de QA')
ON CONFLICT (permission_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Synthetic classification helper (heuristic fallback until flagged)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.copy_is_synthetic(p_copy_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT COALESCE((
    SELECT c.is_synthetic
       OR c.inventory_code LIKE 'IUB-STG-%'
       OR b.author ILIKE '%Staging%'
       OR b.title ILIKE '%Staging%'
       OR b.title ILIKE 'Catalogado resume %'
       OR b.title ILIKE 'Ofrecido COMPLETE%'
    FROM public.copies c
    JOIN public.bibliographic_records b ON b.id = c.bibliographic_record_id
    WHERE c.id = p_copy_id
  ), FALSE);
$function$;

REVOKE ALL ON FUNCTION public.copy_is_synthetic(BIGINT)
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.copy_is_synthetic(BIGINT)
  TO iub_admin_runtime;

-- ---------------------------------------------------------------------------
-- 5. Availability guards
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_institutional_copy_eligibility()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.provenance_type = 'institutional'
     AND NEW.provenance_type <> OLD.provenance_type THEN
    RAISE EXCEPTION 'institutional provenance cannot be changed'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.provenance_type = 'institutional' THEN
    IF NEW.verified_at IS NOT NULL
       AND (
         NEW.verified_by IS NULL
         OR NEW.verification_reference IS NULL
         OR length(btrim(NEW.verification_reference)) < 1
       ) THEN
      RAISE EXCEPTION
        'institutional verification requires an actor and an evidence reference'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.verified_at IS NOT NULL
       AND NEW.physical_condition = 'unassessed' THEN
      RAISE EXCEPTION
        'an institutional copy cannot be verified with unassessed physical condition'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.availability IN ('available', 'reserved')
       AND NEW.verified_at IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM public.catalog_verification_exemptions e
         WHERE e.copy_id = NEW.id
       ) THEN
      RAISE EXCEPTION
        'an unverified institutional copy cannot be available or reserved'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_institutional_copy_eligibility()
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;

DROP TRIGGER IF EXISTS copies_institutional_eligibility_guard ON public.copies;
CREATE TRIGGER copies_institutional_eligibility_guard
  BEFORE INSERT OR UPDATE ON public.copies
  FOR EACH ROW EXECUTE FUNCTION public.guard_institutional_copy_eligibility();

CREATE OR REPLACE FUNCTION public.guard_copy_availability_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF OLD.availability = 'retired'
     AND NEW.availability <> 'retired'
     AND coalesce(current_setting('app.authorized_copy_reinstatement', TRUE), '') <> 'on' THEN
    RAISE EXCEPTION
      'a retired copy requires an authorized reinstatement'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.availability IN ('available', 'reserved')
     AND NEW.availability IN ('unavailable', 'maintenance')
     AND coalesce(current_setting('app.authorized_copy_withdrawal', TRUE), '') <> 'on' THEN
    RAISE EXCEPTION
      'an available copy requires an authorized withdrawal before becoming unavailable'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_copy_availability_transition()
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;

DROP TRIGGER IF EXISTS copies_availability_transition_guard ON public.copies;
CREATE TRIGGER copies_availability_transition_guard
  BEFORE UPDATE ON public.copies
  FOR EACH ROW EXECUTE FUNCTION public.guard_copy_availability_transition();

CREATE OR REPLACE FUNCTION public.guard_institutional_request_copy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_copy public.copies%ROWTYPE;
BEGIN
  SELECT * INTO v_copy FROM public.copies WHERE id = NEW.requested_copy_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copy not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_copy.provenance_type = 'institutional'
     AND v_copy.verified_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.catalog_verification_exemptions e
       WHERE e.copy_id = v_copy.id
     ) THEN
    RAISE EXCEPTION 'institutional copy is not enabled for an exchange request'
      USING ERRCODE = '23514';
  END IF;

  IF v_copy.availability <> 'available' THEN
    RAISE EXCEPTION 'copy is not available for an exchange request'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_institutional_request_copy()
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;

DROP TRIGGER IF EXISTS exchange_requests_institutional_eligibility_guard
  ON public.exchange_requests;
CREATE TRIGGER exchange_requests_institutional_eligibility_guard
  BEFORE INSERT OR UPDATE OF requested_copy_id ON public.exchange_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_institutional_request_copy();

-- ---------------------------------------------------------------------------
-- 6. Audited verification, publication, withdrawal and classification
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.verify_institutional_copy(
  p_copy_id BIGINT,
  p_actor_user_id BIGINT,
  p_evidence_reference TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_copy public.copies%ROWTYPE;
  v_reference TEXT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'inventory.verify');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  v_reference := nullif(btrim(coalesce(p_evidence_reference, '')), '');
  IF v_reference IS NULL OR length(v_reference) > 500 THEN
    RAISE EXCEPTION 'an evidence reference is required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_copy FROM public.copies WHERE id = p_copy_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copy not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_copy.provenance_type <> 'institutional' THEN
    RAISE EXCEPTION 'only institutional copies can be verified' USING ERRCODE = '23514';
  END IF;
  IF v_copy.physical_condition = 'unassessed' THEN
    RAISE EXCEPTION 'the physical condition must be assessed before verification'
      USING ERRCODE = '23514';
  END IF;

  IF v_copy.verified_at IS NOT NULL THEN
    IF v_copy.verification_reference = v_reference THEN
      RETURN v_copy.id;
    END IF;
    RAISE EXCEPTION 'the copy is already verified with a different reference'
      USING ERRCODE = '23505';
  END IF;

  UPDATE public.copies
  SET verified_at = clock_timestamp(),
      verified_by = p_actor_user_id,
      verification_reference = v_reference
  WHERE id = p_copy_id;

  DELETE FROM public.catalog_verification_exemptions WHERE copy_id = p_copy_id;

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id,
     'inventory.institutional_verified',
     'copy',
     p_copy_id::TEXT,
     jsonb_build_object('evidence_reference', v_reference));

  RETURN p_copy_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.verify_institutional_copy(BIGINT, BIGINT, TEXT)
  FROM PUBLIC, iub_public_runtime;
GRANT EXECUTE ON FUNCTION public.verify_institutional_copy(BIGINT, BIGINT, TEXT)
  TO iub_admin_runtime;

CREATE OR REPLACE FUNCTION public.publish_institutional_copy(
  p_copy_id BIGINT,
  p_actor_user_id BIGINT,
  p_idempotency_key UUID
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_copy public.copies%ROWTYPE;
  v_movement public.inventory_movements%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'inventory.publish');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_copy FROM public.copies WHERE id = p_copy_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copy not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_movement
  FROM public.inventory_movements
  WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_movement.copy_id = p_copy_id
       AND v_movement.new_availability = 'available' THEN
      RETURN p_copy_id;
    END IF;
    RAISE EXCEPTION 'idempotency key conflict' USING ERRCODE = '23505';
  END IF;

  IF v_copy.provenance_type <> 'institutional' THEN
    RAISE EXCEPTION 'only institutional copies use this publication path'
      USING ERRCODE = '23514';
  END IF;
  IF v_copy.verified_at IS NULL OR v_copy.physical_condition = 'unassessed' THEN
    RAISE EXCEPTION 'the institutional copy is not verified for publication'
      USING ERRCODE = '23514';
  END IF;
  IF v_copy.availability = 'available' THEN
    RETURN p_copy_id;
  END IF;
  IF v_copy.availability NOT IN ('unavailable', 'maintenance') THEN
    RAISE EXCEPTION 'the copy cannot be published from availability %', v_copy.availability
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.reservations r
    WHERE r.copy_id = p_copy_id AND r.status IN ('active', 'converted')
  ) THEN
    RAISE EXCEPTION 'the copy has an existing reservation or commitment' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.exchanges e
    WHERE e.institutional_copy_id = p_copy_id
      AND e.status IN ('planned', 'in_process', 'cancellation_pending')
  ) THEN
    RAISE EXCEPTION 'the copy is committed to an active exchange' USING ERRCODE = '23514';
  END IF;

  UPDATE public.copies
  SET availability = 'available'
  WHERE id = p_copy_id;

  INSERT INTO public.inventory_movements
    (copy_id, movement_type, previous_availability, new_availability,
     idempotency_key, performed_by, reason)
  VALUES
    (p_copy_id, 'availability_changed', v_copy.availability, 'available',
     p_idempotency_key, p_actor_user_id,
     'institutional copy verified and published');

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id,
     'inventory.institutional_copy_published',
     'copy',
     p_copy_id::TEXT,
     jsonb_build_object('previous_availability', v_copy.availability,
                        'idempotency_key', p_idempotency_key));

  RETURN p_copy_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.publish_institutional_copy(BIGINT, BIGINT, UUID)
  FROM PUBLIC, iub_public_runtime;
GRANT EXECUTE ON FUNCTION public.publish_institutional_copy(BIGINT, BIGINT, UUID)
  TO iub_admin_runtime;

CREATE OR REPLACE FUNCTION public.withdraw_copy(
  p_copy_id BIGINT,
  p_new_availability TEXT,
  p_reason TEXT,
  p_actor_user_id BIGINT,
  p_idempotency_key UUID
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_copy public.copies%ROWTYPE;
  v_movement public.inventory_movements%ROWTYPE;
  v_reason TEXT;
  v_movement_type TEXT;
  v_previous TEXT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'inventory.withdraw');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '23502';
  END IF;
  IF p_new_availability NOT IN ('unavailable', 'maintenance', 'retired') THEN
    RAISE EXCEPTION 'invalid withdrawal target' USING ERRCODE = '23514';
  END IF;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  IF v_reason IS NULL OR length(v_reason) > 3000 THEN
    RAISE EXCEPTION 'a withdrawal reason is required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_copy FROM public.copies WHERE id = p_copy_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copy not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_copy.availability = p_new_availability THEN
    RETURN p_copy_id;
  END IF;

  SELECT * INTO v_movement
  FROM public.inventory_movements
  WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_movement.copy_id = p_copy_id
       AND v_movement.new_availability = p_new_availability THEN
      RETURN p_copy_id;
    END IF;
    RAISE EXCEPTION 'idempotency key conflict' USING ERRCODE = '23505';
  END IF;

  IF v_copy.availability = 'retired' THEN
    RAISE EXCEPTION 'a retired copy cannot be withdrawn again' USING ERRCODE = '23514';
  END IF;
  IF v_copy.availability NOT IN ('available', 'reserved', 'unavailable', 'maintenance') THEN
    RAISE EXCEPTION 'the copy cannot be withdrawn from availability %', v_copy.availability
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.reservations r
    WHERE r.copy_id = p_copy_id AND r.status IN ('active', 'converted')
  ) THEN
    RAISE EXCEPTION 'release, cancel or complete the existing reservation first' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.exchanges e
    WHERE (e.institutional_copy_id = p_copy_id OR e.offered_copy_id = p_copy_id)
      AND e.status IN ('planned', 'in_process', 'cancellation_pending')
  ) THEN
    RAISE EXCEPTION 'the copy is committed to an active exchange' USING ERRCODE = '23514';
  END IF;

  v_previous := v_copy.availability;
  v_movement_type := CASE
    WHEN p_new_availability = 'retired' THEN 'retired'
    ELSE 'availability_changed'
  END;

  PERFORM set_config('app.authorized_copy_withdrawal', 'on', TRUE);

  UPDATE public.copies
  SET availability = p_new_availability
  WHERE id = p_copy_id;

  PERFORM set_config('app.authorized_copy_withdrawal', '', TRUE);

  INSERT INTO public.inventory_movements
    (copy_id, movement_type, previous_availability, new_availability,
     idempotency_key, performed_by, reason)
  VALUES
    (p_copy_id, v_movement_type, v_previous, p_new_availability,
     p_idempotency_key, p_actor_user_id, left(v_reason, 3000));

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id,
     'inventory.copy_withdrawn',
     'copy',
     p_copy_id::TEXT,
     jsonb_build_object('previous_availability', v_previous,
                        'new_availability', p_new_availability,
                        'reason', left(v_reason, 3000),
                        'idempotency_key', p_idempotency_key));

  RETURN p_copy_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.withdraw_copy(BIGINT, TEXT, TEXT, BIGINT, UUID)
  FROM PUBLIC, iub_public_runtime;
GRANT EXECUTE ON FUNCTION public.withdraw_copy(BIGINT, TEXT, TEXT, BIGINT, UUID)
  TO iub_admin_runtime;

CREATE OR REPLACE FUNCTION public.classify_synthetic_inventory(
  p_actor_user_id BIGINT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_count INTEGER;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'inventory.classify_synthetic');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  IF EXISTS (
    SELECT 1
    FROM public.copies c
    WHERE (
      c.inventory_code IN ('IUB-STG-001', 'IUB-STG-002')
      OR (
        c.inventory_code = 'IUB-REC-R-1793222267404'
        AND EXISTS (
          SELECT 1
          FROM public.bibliographic_records b
          WHERE b.id = c.bibliographic_record_id
            AND b.author ILIKE '%Staging%'
            AND b.title ILIKE 'Catalogado resume %'
        )
      )
    )
    AND EXISTS (
      SELECT 1 FROM public.reservations r
      WHERE r.copy_id = c.id AND r.status = 'active'
    )
  ) THEN
    RAISE EXCEPTION 'a synthetic candidate has an active reservation'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.copies c
  SET is_synthetic = TRUE
  WHERE (
    c.inventory_code IN ('IUB-STG-001', 'IUB-STG-002')
    OR (
      c.inventory_code = 'IUB-REC-R-1793222267404'
      AND EXISTS (
        SELECT 1
        FROM public.bibliographic_records b
        WHERE b.id = c.bibliographic_record_id
          AND b.author ILIKE '%Staging%'
          AND b.title ILIKE 'Catalogado resume %'
      )
    )
  )
  AND c.is_synthetic = FALSE;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count > 0 THEN
    INSERT INTO public.audit_events
      (actor_user_id, event_type, resource_type, resource_id, metadata)
    VALUES
      (p_actor_user_id,
       'inventory.synthetic_records_classified',
       'inventory',
       'synthetic-qa-classification',
       jsonb_build_object(
         'copies', v_count,
         'codes', jsonb_build_array('IUB-STG-001', 'IUB-STG-002', 'IUB-REC-R-1793222267404'),
         'availability_changed', FALSE
       ));
  END IF;

  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.classify_synthetic_inventory(BIGINT)
  FROM PUBLIC, iub_public_runtime;
GRANT EXECUTE ON FUNCTION public.classify_synthetic_inventory(BIGINT)
  TO iub_admin_runtime;

-- ---------------------------------------------------------------------------
-- 7. Idempotent event inventory importer
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.inventory_event_imports (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key TEXT NOT NULL CHECK (length(btrim(event_key)) BETWEEN 1 AND 200),
  payload_sha256 BYTEA NOT NULL CHECK (octet_length(payload_sha256) = 32),
  actor_user_id BIGINT NOT NULL REFERENCES public.app_users(id),
  idempotency_key UUID NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  bibs_inserted INTEGER NOT NULL DEFAULT 0 CHECK (bibs_inserted >= 0),
  copies_inserted INTEGER NOT NULL DEFAULT 0 CHECK (copies_inserted >= 0),
  copies_reused INTEGER NOT NULL DEFAULT 0 CHECK (copies_reused >= 0),
  copies_skipped INTEGER NOT NULL DEFAULT 0 CHECK (copies_skipped >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.inventory_event_import_bibs (
  import_id BIGINT NOT NULL REFERENCES public.inventory_event_imports(id),
  bib_key TEXT NOT NULL CHECK (length(btrim(bib_key)) BETWEEN 1 AND 200),
  bibliographic_record_id BIGINT NOT NULL REFERENCES public.bibliographic_records(id),
  PRIMARY KEY (import_id, bib_key)
);

REVOKE ALL ON public.inventory_event_imports, public.inventory_event_import_bibs
  FROM PUBLIC, iub_public_runtime;
GRANT SELECT ON public.inventory_event_imports, public.inventory_event_import_bibs
  TO iub_admin_runtime;

CREATE OR REPLACE FUNCTION public.import_event_inventory(
  p_event_key TEXT,
  p_payload JSONB,
  p_actor_user_id BIGINT,
  p_idempotency_key UUID
)
RETURNS TABLE (
  import_id BIGINT,
  status TEXT,
  bibs_inserted INTEGER,
  copies_inserted INTEGER,
  copies_reused INTEGER,
  copies_skipped INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_import public.inventory_event_imports%ROWTYPE;
  v_import_id BIGINT;
  v_payload_sha256 BYTEA;
  v_bib JSONB;
  v_copy JSONB;
  v_bib_key TEXT;
  v_bib_id BIGINT;
  v_publisher TEXT;
  v_publisher_norm TEXT;
  v_publisher_id BIGINT;
  v_isbn TEXT;
  v_isbn_norm TEXT;
  v_title TEXT;
  v_author TEXT;
  v_code TEXT;
  v_location TEXT;
  v_provenance_reference TEXT;
  v_bibs_inserted INTEGER := 0;
  v_copies_inserted INTEGER := 0;
  v_copies_reused INTEGER := 0;
  v_copies_skipped INTEGER := 0;
  v_copy_id BIGINT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'inventory.events.import');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '23502';
  END IF;
  IF length(btrim(coalesce(p_event_key, ''))) < 1 THEN
    RAISE EXCEPTION 'an event key is required' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(p_payload) <> 'object'
     OR jsonb_typeof(p_payload->'bibs') <> 'array'
     OR jsonb_typeof(p_payload->'copies') <> 'array' THEN
    RAISE EXCEPTION 'the event payload must contain bibs and copies arrays'
      USING ERRCODE = '23514';
  END IF;

  v_payload_sha256 := sha256(convert_to(p_payload::TEXT, 'UTF8'));

  INSERT INTO public.inventory_event_imports
    (event_key, payload_sha256, actor_user_id, idempotency_key, status)
  VALUES
    (btrim(p_event_key), v_payload_sha256, p_actor_user_id, p_idempotency_key, 'processing')
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_import_id;

  IF v_import_id IS NULL THEN
    SELECT * INTO v_import
    FROM public.inventory_event_imports i
    WHERE i.idempotency_key = p_idempotency_key
    FOR UPDATE;

    IF v_import.payload_sha256 IS DISTINCT FROM v_payload_sha256 THEN
      RAISE EXCEPTION 'event import idempotency key conflict' USING ERRCODE = '23505';
    END IF;
    IF v_import.status = 'completed' THEN
      RETURN QUERY SELECT v_import.id, v_import.status,
                          v_import.bibs_inserted, v_import.copies_inserted,
                          v_import.copies_reused, v_import.copies_skipped;
      RETURN;
    END IF;
    RAISE EXCEPTION 'event import is already in progress' USING ERRCODE = '55000';
  END IF;

  v_import.id := v_import_id;

  FOR v_bib IN SELECT value FROM jsonb_array_elements(p_payload->'bibs') LOOP
    v_bib_key := btrim(coalesce(v_bib->>'key', ''));
    v_title := btrim(coalesce(v_bib->>'title', ''));
    v_author := btrim(coalesce(v_bib->>'author', ''));
    IF v_bib_key = '' OR v_title = '' OR v_author = '' THEN
      RAISE EXCEPTION 'a bibliographic row is missing key, title or author'
        USING ERRCODE = '23514';
    END IF;

    v_publisher := nullif(btrim(coalesce(v_bib->>'publisher', '')), '');
    v_publisher_norm := CASE
      WHEN v_publisher IS NULL THEN NULL
      ELSE lower(regexp_replace(v_publisher, '\s+', ' ', 'g'))
    END;
    v_isbn := nullif(btrim(coalesce(v_bib->>'isbn', '')), '');
    v_isbn_norm := nullif(btrim(coalesce(v_bib->>'isbn_normalized', '')), '');

    IF (v_isbn IS NULL) <> (v_isbn_norm IS NULL) THEN
      RAISE EXCEPTION 'bibliographic row % has inconsistent ISBN', v_bib_key
        USING ERRCODE = '23514';
    END IF;

    IF v_publisher_norm IS NOT NULL THEN
      INSERT INTO public.publishers (name, normalized_name)
      VALUES (v_publisher, v_publisher_norm)
      ON CONFLICT (normalized_name) DO NOTHING;
      SELECT id INTO v_publisher_id
      FROM public.publishers
      WHERE normalized_name = v_publisher_norm
      LIMIT 1;
    ELSE
      v_publisher_id := NULL;
    END IF;

    IF v_isbn_norm IS NOT NULL THEN
      SELECT id INTO v_bib_id
      FROM public.bibliographic_records
      WHERE isbn_normalized = v_isbn_norm
      LIMIT 1;
    ELSE
      SELECT id INTO v_bib_id
      FROM public.bibliographic_records
      WHERE isbn_normalized IS NULL
        AND lower(title) = lower(v_title)
        AND lower(author) = lower(v_author)
        AND publisher_id IS NOT DISTINCT FROM v_publisher_id
      LIMIT 1;
    END IF;

    IF v_bib_id IS NULL THEN
      INSERT INTO public.bibliographic_records
        (title, author, publisher_id, isbn, isbn_normalized)
      VALUES
        (v_title, v_author, v_publisher_id, v_isbn, v_isbn_norm)
      RETURNING id INTO v_bib_id;
      v_bibs_inserted := v_bibs_inserted + 1;
    END IF;

    INSERT INTO public.inventory_event_import_bibs
      (import_id, bib_key, bibliographic_record_id)
    VALUES
      (v_import.id, v_bib_key, v_bib_id);
  END LOOP;

  FOR v_copy IN SELECT value FROM jsonb_array_elements(p_payload->'copies') LOOP
    v_code := btrim(coalesce(v_copy->>'code', ''));
    v_bib_key := btrim(coalesce(v_copy->>'bib_key', ''));
    IF v_code = '' OR v_bib_key = '' THEN
      RAISE EXCEPTION 'an inventory row is missing code or bib_key'
        USING ERRCODE = '23514';
    END IF;

    SELECT i.bibliographic_record_id INTO v_bib_id
    FROM public.inventory_event_import_bibs i
    WHERE i.import_id = v_import.id AND i.bib_key = v_bib_key;
    IF v_bib_id IS NULL THEN
      RAISE EXCEPTION 'inventory row % references unknown bib key %', v_code, v_bib_key
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (SELECT 1 FROM public.copies c WHERE c.inventory_code = v_code) THEN
      v_copies_reused := v_copies_reused + 1;
      CONTINUE;
    END IF;

    v_location := nullif(btrim(coalesce(v_copy->>'location', '')), '');
    v_provenance_reference := nullif(btrim(coalesce(v_copy->>'provenance_reference', '')), '');
    IF v_provenance_reference IS NULL THEN
      v_provenance_reference :=
        'event:' || btrim(p_event_key) || ':' || v_code || ':row:' ||
        coalesce(v_copy->>'source_row', '');
    END IF;

    INSERT INTO public.copies
      (bibliographic_record_id, inventory_code, physical_condition, availability,
       location, provenance_type, provenance_reference)
    VALUES
      (v_bib_id, v_code, 'unassessed', 'unavailable',
       v_location, 'institutional', v_provenance_reference)
    RETURNING id INTO v_copy_id;

    INSERT INTO public.inventory_movements
      (copy_id, movement_type, new_availability, performed_by, reason)
    VALUES
      (v_copy_id, 'received', 'unavailable', p_actor_user_id,
       'event inventory import');

    v_copies_inserted := v_copies_inserted + 1;
  END LOOP;

  UPDATE public.inventory_event_imports
  SET status = 'completed',
      bibs_inserted = v_bibs_inserted,
      copies_inserted = v_copies_inserted,
      copies_reused = v_copies_reused,
      copies_skipped = v_copies_skipped,
      completed_at = clock_timestamp()
  WHERE id = v_import.id;

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id,
     'inventory.event_import_completed',
     'inventory_import',
     btrim(p_event_key),
     jsonb_build_object(
       'payload_sha256', encode(v_payload_sha256, 'hex'),
       'bibs_inserted', v_bibs_inserted,
       'copies_inserted', v_copies_inserted,
       'copies_reused', v_copies_reused,
       'copies_skipped', v_copies_skipped,
       'availability', 'unavailable',
       'idempotency_key', p_idempotency_key
     ));

  RETURN QUERY SELECT v_import.id, 'completed'::TEXT,
                      v_bibs_inserted, v_copies_inserted,
                      v_copies_reused, v_copies_skipped;
END;
$function$;

REVOKE ALL ON FUNCTION public.import_event_inventory(TEXT, JSONB, BIGINT, UUID)
  FROM PUBLIC, iub_public_runtime;
GRANT EXECUTE ON FUNCTION public.import_event_inventory(TEXT, JSONB, BIGINT, UUID)
  TO iub_admin_runtime;

-- ---------------------------------------------------------------------------
-- 8. Catalogue, backlog and anomaly views
-- ---------------------------------------------------------------------------

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
WHERE c.availability = 'available'
  AND (
    c.provenance_type <> 'institutional'
    OR (
      c.verified_at IS NOT NULL
      AND c.physical_condition <> 'unassessed'
    )
    OR EXISTS (
      SELECT 1
      FROM public.catalog_verification_exemptions e
      WHERE e.copy_id = c.id
    )
  );

REVOKE ALL ON public.available_catalog FROM PUBLIC, iub_admin_runtime;
GRANT SELECT ON public.available_catalog TO iub_public_runtime;
GRANT SELECT ON public.available_catalog TO iub_admin_runtime;

CREATE OR REPLACE VIEW public.institutional_verification_backlog AS
SELECT
  c.id AS copy_id,
  c.inventory_code,
  c.availability,
  c.physical_condition,
  e.exempted_at,
  e.review_due_at,
  (e.review_due_at IS NOT NULL AND e.review_due_at < clock_timestamp()) AS overdue
FROM public.catalog_verification_exemptions e
JOIN public.copies c ON c.id = e.copy_id
WHERE c.verified_at IS NULL;

REVOKE ALL ON public.institutional_verification_backlog
  FROM PUBLIC, iub_public_runtime;
GRANT SELECT ON public.institutional_verification_backlog TO iub_admin_runtime;

CREATE OR REPLACE VIEW public.inventory_anomalies AS
WITH latest_movement AS (
  SELECT DISTINCT ON (m.copy_id)
    m.copy_id,
    m.id,
    m.movement_type,
    m.previous_availability,
    m.new_availability,
    m.occurred_at
  FROM public.inventory_movements m
  ORDER BY m.copy_id, m.occurred_at DESC, m.id DESC
),
base AS (
  SELECT
    c.id AS copy_id,
    c.inventory_code,
    c.availability,
    c.provenance_type,
    c.verified_at,
    public.copy_is_synthetic(c.id) AS is_synthetic,
    b.title,
    b.author
  FROM public.copies c
  JOIN public.bibliographic_records b ON b.id = c.bibliographic_record_id
)
SELECT
  'synthetic_copy_in_catalog'::TEXT AS anomaly_code,
  'critical'::TEXT AS severity,
  b.copy_id,
  NULL::BIGINT AS admission_id,
  NULL::BIGINT AS exchange_id,
  b.inventory_code,
  b.is_synthetic,
  jsonb_build_object('title', b.title, 'author', b.author, 'availability', b.availability) AS details,
  clock_timestamp() AS detected_at
FROM base b
WHERE b.is_synthetic
  AND EXISTS (SELECT 1 FROM public.available_catalog ac WHERE ac.copy_id = b.copy_id)
UNION ALL
SELECT
  'availability_history_mismatch',
  'high',
  b.copy_id,
  NULL,
  NULL,
  b.inventory_code,
  b.is_synthetic,
  jsonb_build_object(
    'current_availability', b.availability,
    'last_movement_type', lm.movement_type,
    'last_previous_availability', lm.previous_availability,
    'last_new_availability', lm.new_availability,
    'last_movement_at', lm.occurred_at
  ),
  clock_timestamp()
FROM base b
JOIN latest_movement lm ON lm.copy_id = b.copy_id
WHERE b.availability IS DISTINCT FROM lm.new_availability
  AND lm.movement_type <> 'received'
  AND NOT EXISTS (
    SELECT 1 FROM public.catalog_verification_exemptions e
    WHERE e.copy_id = b.copy_id
  )
UNION ALL
SELECT
  'completed_exchange_copy_not_available',
  'high',
  b.copy_id,
  a.id,
  e.id,
  b.inventory_code,
  b.is_synthetic,
  jsonb_build_object(
    'availability', b.availability,
    'exchange_status', e.status,
    'admission_status', a.status
  ),
  clock_timestamp()
FROM base b
JOIN public.exchanges e
  ON e.offered_copy_id = b.copy_id
 AND e.status = 'completed'
LEFT JOIN public.inventory_admissions a
  ON a.copy_id = b.copy_id
WHERE b.availability NOT IN ('available', 'reserved', 'retired', 'maintenance')
UNION ALL
SELECT
  'unverified_institutional_in_catalog',
  'critical',
  b.copy_id,
  NULL,
  NULL,
  b.inventory_code,
  b.is_synthetic,
  jsonb_build_object('availability', b.availability),
  clock_timestamp()
FROM base b
WHERE b.provenance_type = 'institutional'
  AND b.availability = 'available'
  AND b.verified_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.catalog_verification_exemptions e
    WHERE e.copy_id = b.copy_id
  )
UNION ALL
SELECT
  'retired_copy_with_active_hold',
  'critical',
  b.copy_id,
  NULL,
  r.request_id,
  b.inventory_code,
  b.is_synthetic,
  jsonb_build_object('reservation_id', r.id, 'reservation_status', r.status),
  clock_timestamp()
FROM base b
JOIN public.reservations r
  ON r.copy_id = b.copy_id
 AND r.status = 'active'
WHERE b.availability = 'retired';

REVOKE ALL ON public.inventory_anomalies
  FROM PUBLIC, iub_public_runtime;
GRANT SELECT ON public.inventory_anomalies TO iub_admin_runtime;

CREATE OR REPLACE VIEW public.real_inventory_anomalies AS
SELECT *
FROM public.inventory_anomalies
WHERE NOT is_synthetic;

REVOKE ALL ON public.real_inventory_anomalies
  FROM PUBLIC, iub_public_runtime;
GRANT SELECT ON public.real_inventory_anomalies TO iub_admin_runtime;

CREATE OR REPLACE VIEW public.inventory_anomaly_counts AS
SELECT
  anomaly_code,
  severity,
  is_synthetic,
  count(*)::INTEGER AS count
FROM public.inventory_anomalies
GROUP BY anomaly_code, severity, is_synthetic;

REVOKE ALL ON public.inventory_anomaly_counts
  FROM PUBLIC, iub_public_runtime;
GRANT SELECT ON public.inventory_anomaly_counts TO iub_admin_runtime;
