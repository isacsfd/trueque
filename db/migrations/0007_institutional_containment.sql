-- Seventh versioned migration. P0 containment for unverified institutional
-- copies. Additive: adds verification metadata, eligibility guards and replaces
-- the public catalogue view and reserve_copy without editing historical files.
--
-- This migration does not verify, accept, inspect or enable any copy. It only
-- withholds institutional copies that have no positive verification record and
-- records that containment in audit_events. It creates no inventory_movements.

-- ---------------------------------------------------------------------------
-- 1. Positive verification metadata
-- ---------------------------------------------------------------------------

ALTER TABLE public.copies
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_by BIGINT REFERENCES public.app_users(id),
  ADD COLUMN IF NOT EXISTS verification_reference TEXT;

DO $block$
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
$block$;

COMMENT ON COLUMN public.copies.verified_at IS
  'Positive institutional verification timestamp. NULL means the copy has not been institutionally verified.';
COMMENT ON COLUMN public.copies.verified_by IS
  'Active administrative actor that approved the institutional verification.';
COMMENT ON COLUMN public.copies.verification_reference IS
  'Evidence reference for the institutional verification decision.';

CREATE INDEX IF NOT EXISTS copies_institutional_unverified_idx
  ON public.copies (availability, id)
  WHERE provenance_type = 'institutional' AND verified_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Containment of existing unverified institutional copies
-- ---------------------------------------------------------------------------

DO $block$
DECLARE
  v_blocked INTEGER;
  v_updated INTEGER;
BEGIN
  -- Refuse to hide copies that are part of a real commitment or already have
  -- inventory history. A human must review those cases before containment.
  SELECT count(*) INTO v_blocked
  FROM public.copies c
  WHERE c.provenance_type = 'institutional'
    AND c.verified_at IS NULL
    AND (
      EXISTS (
        SELECT 1 FROM public.reservations r
        WHERE r.copy_id = c.id AND r.status = 'active'
      )
      OR EXISTS (
        SELECT 1 FROM public.exchanges e
        WHERE e.institutional_copy_id = c.id
          AND e.status IN ('planned', 'in_process', 'cancellation_pending')
      )
      OR EXISTS (
        SELECT 1 FROM public.exchange_requests r
        WHERE r.requested_copy_id = c.id
          AND r.status NOT IN ('completed', 'cancelled', 'rejected')
      )
      OR EXISTS (
        SELECT 1 FROM public.inventory_movements m
        WHERE m.copy_id = c.id
      )
    );

  IF v_blocked > 0 THEN
    RAISE EXCEPTION
      'cannot contain % unverified institutional copies with active commitments or history',
      v_blocked
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.copies
  SET availability = 'unavailable'
  WHERE provenance_type = 'institutional'
    AND verified_at IS NULL
    AND availability IN ('available', 'reserved');

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated > 0 THEN
    INSERT INTO public.audit_events
      (actor_user_id, event_type, resource_type, resource_id, metadata)
    VALUES
      (NULL,
       'inventory.institutional_containment_applied',
       'inventory',
       '0007_institutional_containment',
       jsonb_build_object(
         'reason', 'Unverified institutional copies withheld from catalogue and reservations',
         'copies_updated', v_updated,
         'policy', 'institutional copies require positive verification before availability'
       ));
  END IF;
END
$block$;

-- ---------------------------------------------------------------------------
-- 3. Eligibility predicate
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.inventory_copy_is_eligible(p_copy_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT COALESCE((
    SELECT c.availability = 'available'
       AND (
         c.provenance_type <> 'institutional'
         OR (
           c.verified_at IS NOT NULL
           AND c.physical_condition <> 'unassessed'
         )
       )
    FROM public.copies c
    WHERE c.id = p_copy_id
  ), FALSE);
$function$;

REVOKE ALL ON FUNCTION public.inventory_copy_is_eligible(BIGINT)
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;

-- ---------------------------------------------------------------------------
-- 4. Guard on the copies table
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_institutional_copy_eligibility()
RETURNS TRIGGER
LANGUAGE plpgsql
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
       AND NEW.verified_at IS NULL THEN
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

-- ---------------------------------------------------------------------------
-- 5. Reservation gate (same signature and grants as 0004)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reserve_copy(
  p_copy_id BIGINT,
  p_request_id BIGINT,
  p_access_hash BYTEA,
  p_idempotency_key UUID
)
RETURNS TABLE (reservation_id BIGINT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request public.exchange_requests%ROWTYPE;
  v_copy public.copies%ROWTYPE;
  v_existing public.reservations%ROWTYPE;
  v_ttl INTEGER;
  v_new_id BIGINT;
  v_expires_at TIMESTAMPTZ;
  v_expired RECORD;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '23502';
  END IF;

  v_request := public.iub_lock_request(p_request_id);

  IF v_request.request_access_token_sha256 IS NULL
     OR v_request.request_access_token_sha256 IS DISTINCT FROM p_access_hash THEN
    RAISE EXCEPTION 'the request proof is invalid' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_existing FROM public.reservations r WHERE r.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.copy_id <> p_copy_id OR v_existing.request_id <> p_request_id THEN
      RAISE EXCEPTION 'reservation idempotency key conflict' USING ERRCODE = '23505';
    END IF;
    IF v_existing.status <> 'active' THEN
      RAISE EXCEPTION 'the reservation is no longer active' USING ERRCODE = '23514';
    END IF;
    reservation_id := v_existing.id;
    expires_at := v_existing.expires_at;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_request.status NOT IN ('pending', 'under_review', 'approved', 'scheduled') THEN
    RAISE EXCEPTION 'request is not eligible to reserve a copy' USING ERRCODE = '23514';
  END IF;
  IF v_request.requested_copy_id <> p_copy_id THEN
    RAISE EXCEPTION 'copy does not match the requested copy' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_copy FROM public.copies WHERE id = p_copy_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copy not found' USING ERRCODE = 'P0002';
  END IF;

  -- Reject before the expiry loop so an unverified copy is never mutated or
  -- released by a reservation attempt.
  IF v_copy.provenance_type = 'institutional'
     AND (
       v_copy.verified_at IS NULL
       OR v_copy.physical_condition = 'unassessed'
     ) THEN
    RAISE EXCEPTION 'institutional copy is not enabled for reservation'
      USING ERRCODE = '23514';
  END IF;

  SELECT duration_seconds INTO v_ttl FROM public.reservation_policy WHERE policy_id = 1;
  IF v_ttl IS NULL THEN
    RAISE EXCEPTION 'the reservation policy is not configured' USING ERRCODE = '55000';
  END IF;

  FOR v_expired IN
    UPDATE public.reservations r
    SET status = 'expired', released_at = clock_timestamp()
    WHERE r.copy_id = p_copy_id AND r.status = 'active' AND r.expires_at <= clock_timestamp()
    RETURNING r.id, r.copy_id
  LOOP
    INSERT INTO public.inventory_movements
      (copy_id, movement_type, previous_availability, new_availability, reason)
    VALUES
      (v_expired.copy_id, 'reservation_released', 'reserved', 'available', 'reservation expired');
    UPDATE public.copies SET availability = 'available'
    WHERE id = v_expired.copy_id AND availability = 'reserved';
  END LOOP;

  SELECT * INTO v_copy FROM public.copies WHERE id = p_copy_id FOR UPDATE;
  IF NOT public.inventory_copy_is_eligible(p_copy_id) THEN
    RAISE EXCEPTION 'copy is not available' USING ERRCODE = '23514';
  END IF;

  v_expires_at := clock_timestamp() + make_interval(secs => v_ttl);
  INSERT INTO public.reservations (copy_id, request_id, status, idempotency_key, expires_at)
  VALUES (p_copy_id, p_request_id, 'active', p_idempotency_key, v_expires_at)
  RETURNING id INTO v_new_id;

  UPDATE public.copies SET availability = 'reserved' WHERE id = p_copy_id;
  INSERT INTO public.inventory_movements
    (copy_id, movement_type, previous_availability, new_availability, idempotency_key, reason)
  VALUES
    (p_copy_id, 'reserved', 'available', 'reserved', p_idempotency_key, 'temporary exchange reservation');

  reservation_id := v_new_id;
  expires_at := v_expires_at;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_copy(BIGINT, BIGINT, BYTEA, UUID)
  FROM PUBLIC, iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.reserve_copy(BIGINT, BIGINT, BYTEA, UUID)
  TO iub_public_runtime;

-- ---------------------------------------------------------------------------
-- 6. Request gate: no request may target an unverified institutional copy
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_institutional_request_copy()
RETURNS TRIGGER
LANGUAGE plpgsql
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
     AND (
       v_copy.verified_at IS NULL
       OR v_copy.physical_condition = 'unassessed'
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
-- 7. Catalogue gate
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
  );

REVOKE ALL ON public.available_catalog FROM PUBLIC, iub_admin_runtime;
GRANT SELECT ON public.available_catalog TO iub_public_runtime;

-- Preserve the 0004 exchange-received guard; this migration only adds the
-- institutional gate. It does not create, verify or enable any copy.
