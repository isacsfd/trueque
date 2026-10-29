-- Fourth versioned migration. Additive P0 integrity corrections over 0001-0003.
-- 0001, 0002 and 0003 are not edited or replayed. This file only widens
-- reviewed state machines, adds append-only compensation records, replaces
-- function bodies with the same signature, and adds defence-in-depth guards.

-- ---------------------------------------------------------------------------
-- 1. Reviewed state-machine extensions
-- ---------------------------------------------------------------------------

ALTER TABLE public.exchange_requests DROP CONSTRAINT exchange_requests_status_check;
ALTER TABLE public.exchange_requests ADD CONSTRAINT exchange_requests_status_check
  CHECK (status IN (
    'pending', 'under_review', 'approved', 'rejected', 'scheduled', 'in_process',
    'cancellation_pending', 'completed', 'cancelled'
  ));

ALTER TABLE public.exchanges DROP CONSTRAINT exchanges_status_check;
ALTER TABLE public.exchanges ADD CONSTRAINT exchanges_status_check
  CHECK (status IN ('planned', 'in_process', 'cancellation_pending', 'completed', 'cancelled'));

ALTER TABLE public.receptions DROP CONSTRAINT receptions_status_check;
ALTER TABLE public.receptions ADD CONSTRAINT receptions_status_check
  CHECK (status IN (
    'awaiting_delivery', 'received', 'in_custody', 'evaluated', 'accepted',
    'rejected', 'return_pending', 'returned', 'cancelled'
  ));

ALTER TABLE public.request_status_history
  DROP CONSTRAINT request_status_history_previous_status_check;
ALTER TABLE public.request_status_history
  DROP CONSTRAINT request_status_history_new_status_check;
ALTER TABLE public.request_status_history ADD CONSTRAINT request_status_history_previous_status_check
  CHECK (previous_status IS NULL OR previous_status IN (
    'pending', 'under_review', 'approved', 'rejected', 'scheduled', 'in_process',
    'cancellation_pending', 'completed', 'cancelled'
  ));
ALTER TABLE public.request_status_history ADD CONSTRAINT request_status_history_new_status_check
  CHECK (new_status IN (
    'pending', 'under_review', 'approved', 'rejected', 'scheduled', 'in_process',
    'cancellation_pending', 'completed', 'cancelled'
  ));

ALTER TABLE public.reception_status_history
  DROP CONSTRAINT reception_status_history_previous_status_check;
ALTER TABLE public.reception_status_history
  DROP CONSTRAINT reception_status_history_new_status_check;
ALTER TABLE public.reception_status_history ADD CONSTRAINT reception_status_history_previous_status_check
  CHECK (previous_status IS NULL OR previous_status IN (
    'awaiting_delivery', 'received', 'in_custody', 'evaluated', 'accepted',
    'rejected', 'return_pending', 'returned', 'cancelled'
  ));
ALTER TABLE public.reception_status_history ADD CONSTRAINT reception_status_history_new_status_check
  CHECK (new_status IN (
    'awaiting_delivery', 'received', 'in_custody', 'evaluated', 'accepted',
    'rejected', 'return_pending', 'returned', 'cancelled'
  ));

ALTER TABLE public.inventory_admissions DROP CONSTRAINT inventory_admissions_status_check;
ALTER TABLE public.inventory_admissions ADD CONSTRAINT inventory_admissions_status_check
  CHECK (status IN ('pending', 'authorized', 'admitted', 'enabled', 'reversed', 'rejected'));

ALTER TABLE public.exchanges ADD COLUMN cancellation_pending_at TIMESTAMPTZ;
ALTER TABLE public.inventory_admissions ADD COLUMN reversed_by BIGINT REFERENCES public.app_users(id);
ALTER TABLE public.inventory_admissions ADD COLUMN reversed_at TIMESTAMPTZ;
ALTER TABLE public.inventory_admissions ADD CONSTRAINT inventory_admissions_reversed_ck
  CHECK (status <> 'reversed' OR (reversed_by IS NOT NULL AND reversed_at IS NOT NULL)) NOT VALID;
ALTER TABLE public.inventory_admissions VALIDATE CONSTRAINT inventory_admissions_reversed_ck;

-- ---------------------------------------------------------------------------
-- 2. Append-only compensation record for a property transfer reversal
-- ---------------------------------------------------------------------------

CREATE TABLE public.ownership_transfer_reversals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id BIGINT NOT NULL UNIQUE REFERENCES public.ownership_transfers(id),
  return_delivery_id BIGINT NOT NULL UNIQUE REFERENCES public.deliveries(id),
  reversed_by BIGINT NOT NULL REFERENCES public.app_users(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 3000),
  evidence_reference TEXT NOT NULL CHECK (length(trim(evidence_reference)) BETWEEN 1 AND 500),
  idempotency_key UUID NOT NULL UNIQUE,
  reversed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER ownership_transfer_reversals_immutable
  BEFORE UPDATE OR DELETE ON public.ownership_transfer_reversals
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();

REVOKE ALL ON public.ownership_transfer_reversals FROM PUBLIC, iub_public_runtime, iub_admin_runtime;
GRANT SELECT ON public.ownership_transfer_reversals TO iub_admin_runtime;

-- ---------------------------------------------------------------------------
-- 3. Structural integrity indexes already exist in 0001/0002:
--    reservations_one_active_per_copy_uidx and
--    book_evaluations_one_final_per_reception_uidx are intentionally not
--    recreated here.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4. Internal lock and guard primitives
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.iub_lock_request(p_request_id BIGINT)
RETURNS public.exchange_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request public.exchange_requests%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('iub:request:' || p_request_id::TEXT, 0));
  SELECT * INTO v_request FROM public.exchange_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_request;
END;
$function$;

REVOKE ALL ON FUNCTION public.iub_lock_request(BIGINT)
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;

CREATE FUNCTION public.guard_inventory_admission_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_status TEXT;
BEGIN
  SELECT r.status INTO v_status
  FROM public.receptions rec
  JOIN public.exchange_requests r ON r.id = rec.request_id
  WHERE rec.id = NEW.reception_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'reception not found' USING ERRCODE = 'P0002';
  END IF;
  IF NEW.status IN ('authorized', 'admitted', 'enabled')
     AND v_status NOT IN ('scheduled', 'in_process') THEN
    RAISE EXCEPTION 'inventory admission requires an active exchange request' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_inventory_admission_request()
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;

CREATE TRIGGER inventory_admissions_request_guard
  BEFORE INSERT OR UPDATE ON public.inventory_admissions
  FOR EACH ROW EXECUTE FUNCTION public.guard_inventory_admission_request();

CREATE FUNCTION public.guard_ownership_transfer_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_status TEXT;
BEGIN
  SELECT r.status INTO v_status
  FROM public.receptions rec
  JOIN public.exchange_requests r ON r.id = rec.request_id
  WHERE rec.id = NEW.reception_id;

  IF v_status IS NULL OR v_status NOT IN ('scheduled', 'in_process') THEN
    RAISE EXCEPTION 'ownership transfer requires an active exchange request' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_ownership_transfer_request()
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;

CREATE TRIGGER ownership_transfers_request_guard
  BEFORE INSERT ON public.ownership_transfers
  FOR EACH ROW EXECUTE FUNCTION public.guard_ownership_transfer_request();

CREATE FUNCTION public.guard_exchange_received_availability()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.provenance_type = 'exchange_received'
     AND NEW.availability = 'available'
     AND coalesce(current_setting('app.exchange_completion', TRUE), '') <> 'on' THEN
    RAISE EXCEPTION 'an exchange-received copy cannot become available before completion'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_exchange_received_availability()
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;

CREATE TRIGGER copies_exchange_received_availability_guard
  BEFORE INSERT OR UPDATE ON public.copies
  FOR EACH ROW EXECUTE FUNCTION public.guard_exchange_received_availability();

-- ---------------------------------------------------------------------------
-- 5. Reservation and expiry routines
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
  IF v_copy.availability <> 'available' THEN
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

CREATE OR REPLACE FUNCTION public.expire_reservations(p_actor_user_id BIGINT, p_limit INTEGER DEFAULT 100)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_count INTEGER := 0;
  v_candidate RECORD;
  v_copy public.copies%ROWTYPE;
  v_reservation public.reservations%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'reservations.expire');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  FOR v_candidate IN
    SELECT r.id, r.copy_id, r.request_id
    FROM public.reservations r
    WHERE r.status = 'active' AND r.expires_at <= clock_timestamp()
    ORDER BY r.request_id, r.copy_id, r.id
    LIMIT greatest(coalesce(p_limit, 100), 1)
  LOOP
    PERFORM public.iub_lock_request(v_candidate.request_id);

    SELECT * INTO v_copy FROM public.copies WHERE id = v_candidate.copy_id FOR UPDATE;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_reservation
    FROM public.reservations
    WHERE id = v_candidate.id AND status = 'active' AND expires_at <= clock_timestamp()
    FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    UPDATE public.reservations
    SET status = 'expired', released_at = clock_timestamp()
    WHERE id = v_reservation.id;

    IF v_copy.availability = 'reserved'
       AND NOT EXISTS (
         SELECT 1 FROM public.reservations r
         WHERE r.copy_id = v_copy.id AND r.status = 'active' AND r.id <> v_reservation.id
       ) THEN
      UPDATE public.copies SET availability = 'available' WHERE id = v_copy.id;
      INSERT INTO public.inventory_movements
        (copy_id, movement_type, previous_availability, new_availability, idempotency_key, reason)
      VALUES
        (v_copy.id, 'reservation_released', 'reserved', 'available',
         md5('expire:' || v_reservation.id::TEXT)::UUID, 'reservation expired');
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Request, planning and delivery routines
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_request_status(
  p_request_id BIGINT,
  p_new_status TEXT,
  p_actor_user_id BIGINT,
  p_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request public.exchange_requests%ROWTYPE;
  v_reservation public.reservations%ROWTYPE;
BEGIN
  IF p_new_status = 'cancellation_pending' THEN
    RAISE EXCEPTION 'use cancel_exchange to request a cancellation' USING ERRCODE = '23514';
  END IF;
  IF p_new_status = 'completed' THEN
    RAISE EXCEPTION 'use complete_exchange to complete a request' USING ERRCODE = '23514';
  END IF;

  PERFORM public.assert_actor_permission(p_actor_user_id, 'requests.review');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  v_request := public.iub_lock_request(p_request_id);

  IF p_new_status = v_request.status THEN
    RETURN;
  END IF;
  IF v_request.status = 'cancellation_pending' THEN
    RAISE EXCEPTION 'use cancel_exchange for a cancellation pending physical return' USING ERRCODE = '23514';
  END IF;
  IF p_new_status IN ('cancelled', 'rejected')
     AND EXISTS (SELECT 1 FROM public.exchanges WHERE request_id = p_request_id) THEN
    RAISE EXCEPTION 'use cancel_exchange for a request with an exchange' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (v_request.status = 'pending' AND p_new_status = 'under_review')
    OR (v_request.status = 'under_review' AND p_new_status IN ('approved', 'rejected'))
    OR (v_request.status = 'approved' AND p_new_status IN ('cancelled', 'rejected'))
    OR (v_request.status = 'scheduled' AND p_new_status IN ('cancelled', 'rejected'))
  ) THEN
    RAISE EXCEPTION 'invalid request status transition from % to %', v_request.status, p_new_status
      USING ERRCODE = '23514';
  END IF;

  IF p_new_status IN ('cancelled', 'rejected') THEN
    SELECT * INTO v_reservation
    FROM public.reservations
    WHERE request_id = p_request_id AND status = 'active';

    IF FOUND THEN
      PERFORM 1 FROM public.copies WHERE id = v_reservation.copy_id FOR UPDATE;
      SELECT * INTO v_reservation
      FROM public.reservations
      WHERE id = v_reservation.id
      FOR UPDATE;

      UPDATE public.reservations
      SET status = 'released', released_at = clock_timestamp()
      WHERE id = v_reservation.id;
      UPDATE public.copies
      SET availability = 'available'
      WHERE id = v_reservation.copy_id AND availability = 'reserved';
      INSERT INTO public.inventory_movements
        (copy_id, movement_type, previous_availability, new_availability, reason)
      VALUES
        (v_reservation.copy_id, 'reservation_released', 'reserved', 'available', 'request cancelled');
    END IF;
  END IF;

  UPDATE public.exchange_requests SET status = p_new_status WHERE id = p_request_id;
  INSERT INTO public.request_status_history
    (request_id, previous_status, new_status, changed_by, reason)
  VALUES
    (p_request_id, v_request.status, p_new_status, p_actor_user_id, left(coalesce(p_reason, ''), 3000));
  INSERT INTO public.state_history
    (entity_type, entity_id, previous_state, new_state, changed_by, reason)
  VALUES
    ('exchange_request', p_request_id, v_request.status, p_new_status, p_actor_user_id, left(coalesce(p_reason, ''), 3000));
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'request.status_changed', 'exchange_request', p_request_id::TEXT,
     jsonb_build_object('from', v_request.status, 'to', p_new_status));
END;
$function$;

CREATE OR REPLACE FUNCTION public.plan_exchange(
  p_request_id BIGINT,
  p_receipt_code TEXT,
  p_planning_key UUID,
  p_actor_user_id BIGINT
)
RETURNS TABLE (exchange_id BIGINT, reception_id BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request public.exchange_requests%ROWTYPE;
  v_existing public.exchanges%ROWTYPE;
  v_offer_id BIGINT;
  v_new_reception_id BIGINT;
  v_new_exchange_id BIGINT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'exchange.plan');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  v_request := public.iub_lock_request(p_request_id);

  SELECT * INTO v_existing FROM public.exchanges WHERE planning_key = p_planning_key;
  IF FOUND THEN
    IF v_existing.request_id <> p_request_id THEN
      RAISE EXCEPTION 'exchange planning key conflict' USING ERRCODE = '23505';
    END IF;
    exchange_id := v_existing.id;
    reception_id := v_existing.offered_reception_id;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_request.status <> 'approved' THEN
    RAISE EXCEPTION 'only an approved request can be scheduled' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.reservations r
    WHERE r.request_id = p_request_id AND r.copy_id = v_request.requested_copy_id
      AND r.status = 'active' AND r.expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'an active reservation is required to schedule an exchange' USING ERRCODE = '23514';
  END IF;
  SELECT id INTO v_offer_id FROM public.offered_books WHERE request_id = p_request_id;
  IF v_offer_id IS NULL THEN
    RAISE EXCEPTION 'request has no offered book' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.receptions WHERE request_id = p_request_id) THEN
    RAISE EXCEPTION 'request already has a reception' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.receptions (request_id, offered_book_id, receipt_code)
  VALUES (p_request_id, v_offer_id, p_receipt_code)
  RETURNING id INTO v_new_reception_id;

  INSERT INTO public.exchanges
    (request_id, institutional_copy_id, offered_reception_id, accepted_reception_id, planning_key, status)
  VALUES
    (p_request_id, v_request.requested_copy_id, v_new_reception_id, v_new_reception_id, p_planning_key, 'planned')
  RETURNING id INTO v_new_exchange_id;

  UPDATE public.exchange_requests SET status = 'scheduled' WHERE id = p_request_id;
  INSERT INTO public.request_status_history
    (request_id, previous_status, new_status, changed_by, reason)
  VALUES
    (p_request_id, 'approved', 'scheduled', p_actor_user_id, 'exchange planned');
  INSERT INTO public.state_history
    (entity_type, entity_id, previous_state, new_state, changed_by, reason)
  VALUES
    ('exchange', v_new_exchange_id, NULL, 'planned', p_actor_user_id, 'exchange planned'),
    ('exchange_request', p_request_id, 'approved', 'scheduled', p_actor_user_id, 'exchange planned');
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'exchange.planned', 'exchange', v_new_exchange_id::TEXT,
     jsonb_build_object('request_id', p_request_id, 'reception_id', v_new_reception_id));

  exchange_id := v_new_exchange_id;
  reception_id := v_new_reception_id;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.schedule_delivery(
  p_exchange_id BIGINT,
  p_delivery_type TEXT,
  p_scheduled_at TIMESTAMPTZ,
  p_idempotency_key UUID,
  p_actor_user_id BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request public.exchange_requests%ROWTYPE;
  v_request_id BIGINT;
  v_exchange public.exchanges%ROWTYPE;
  v_reception public.receptions%ROWTYPE;
  v_existing public.deliveries%ROWTYPE;
  v_delivery_id BIGINT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'delivery.schedule');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT request_id INTO v_request_id FROM public.exchanges WHERE id = p_exchange_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exchange not found' USING ERRCODE = 'P0002';
  END IF;

  v_request := public.iub_lock_request(v_request_id);
  SELECT * INTO v_exchange FROM public.exchanges WHERE id = p_exchange_id FOR UPDATE;
  SELECT * INTO v_reception FROM public.receptions WHERE request_id = v_request_id FOR UPDATE;

  SELECT * INTO v_existing FROM public.deliveries WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.exchange_id <> p_exchange_id OR v_existing.delivery_type <> p_delivery_type THEN
      RAISE EXCEPTION 'delivery idempotency key conflict' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.id;
  END IF;

  IF p_delivery_type NOT IN ('offered_book_dropoff', 'offered_book_return', 'institutional_copy_handover') THEN
    RAISE EXCEPTION 'unknown delivery type' USING ERRCODE = '23514';
  END IF;

  IF p_delivery_type = 'offered_book_return' THEN
    IF v_reception.id IS NULL OR v_reception.status <> 'return_pending' THEN
      RAISE EXCEPTION 'the reception is not pending return' USING ERRCODE = '23514';
    END IF;
    IF v_request.status NOT IN ('cancellation_pending', 'rejected', 'cancelled', 'in_process') THEN
      RAISE EXCEPTION 'the request is not eligible for a return delivery' USING ERRCODE = '23514';
    END IF;
  ELSIF p_delivery_type = 'offered_book_dropoff' THEN
    IF v_exchange.status <> 'planned' OR v_request.status <> 'scheduled' THEN
      RAISE EXCEPTION 'a dropoff requires a planned exchange and a scheduled request' USING ERRCODE = '23514';
    END IF;
    IF v_reception.id IS NULL OR v_reception.status <> 'awaiting_delivery' THEN
      RAISE EXCEPTION 'the reception is not awaiting delivery' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF v_exchange.status <> 'in_process' OR v_request.status <> 'in_process' THEN
      RAISE EXCEPTION 'a handover requires an in-process exchange' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.deliveries d
    WHERE d.exchange_id = p_exchange_id AND d.delivery_type = p_delivery_type
      AND d.status IN ('scheduled', 'in_progress', 'completed')
  ) THEN
    RAISE EXCEPTION 'a delivery of this type already exists for the exchange' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.deliveries
    (request_id, reception_id, exchange_id, delivery_type, status, scheduled_at, recorded_by, idempotency_key)
  VALUES
    (v_request_id, v_reception.id, p_exchange_id, p_delivery_type, 'scheduled',
     coalesce(p_scheduled_at, clock_timestamp()), p_actor_user_id, p_idempotency_key)
  RETURNING id INTO v_delivery_id;

  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'delivery.scheduled', 'delivery', v_delivery_id::TEXT,
     jsonb_build_object('exchange_id', p_exchange_id, 'type', p_delivery_type));

  RETURN v_delivery_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_delivery(
  p_delivery_id BIGINT,
  p_actor_user_id BIGINT,
  p_receipt_reference TEXT,
  p_notes TEXT,
  p_idempotency_key UUID
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_delivery public.deliveries%ROWTYPE;
  v_request public.exchange_requests%ROWTYPE;
  v_exchange public.exchanges%ROWTYPE;
  v_reception public.receptions%ROWTYPE;
  v_exchange_id BIGINT;
  v_request_id BIGINT;
  v_reception_id BIGINT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'delivery.confirm');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT exchange_id, request_id, reception_id
  INTO v_exchange_id, v_request_id, v_reception_id
  FROM public.deliveries WHERE id = p_delivery_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery not found' USING ERRCODE = 'P0002';
  END IF;

  v_request := public.iub_lock_request(v_request_id);
  IF v_exchange_id IS NOT NULL THEN
    SELECT * INTO v_exchange FROM public.exchanges WHERE id = v_exchange_id FOR UPDATE;
  END IF;
  IF v_reception_id IS NOT NULL THEN
    SELECT * INTO v_reception FROM public.receptions WHERE id = v_reception_id FOR UPDATE;
  END IF;
  SELECT * INTO v_delivery FROM public.deliveries WHERE id = p_delivery_id FOR UPDATE;

  IF v_delivery.idempotency_key IS DISTINCT FROM p_idempotency_key THEN
    RAISE EXCEPTION 'delivery idempotency key mismatch' USING ERRCODE = '23505';
  END IF;
  IF v_delivery.status = 'completed' THEN
    RETURN v_delivery.id;
  END IF;
  IF v_delivery.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'delivery is not confirmable' USING ERRCODE = '23514';
  END IF;
  IF length(trim(coalesce(p_receipt_reference, ''))) < 1 THEN
    RAISE EXCEPTION 'a receipt reference is required to confirm a delivery' USING ERRCODE = '23514';
  END IF;

  IF v_delivery.delivery_type = 'offered_book_dropoff' THEN
    IF v_exchange.status <> 'planned' OR v_request.status <> 'scheduled' THEN
      RAISE EXCEPTION 'a dropoff can only be confirmed for a planned exchange' USING ERRCODE = '23514';
    END IF;
    IF v_reception.status <> 'awaiting_delivery' THEN
      RAISE EXCEPTION 'the reception is not awaiting delivery' USING ERRCODE = '23514';
    END IF;
  ELSIF v_delivery.delivery_type = 'institutional_copy_handover' THEN
    IF v_exchange.status <> 'in_process' OR v_request.status <> 'in_process' THEN
      RAISE EXCEPTION 'a handover requires an in-process exchange' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF v_reception.status <> 'return_pending' THEN
      RAISE EXCEPTION 'the reception is not pending return' USING ERRCODE = '23514';
    END IF;
    IF v_request.status NOT IN ('cancellation_pending', 'rejected', 'cancelled', 'in_process') THEN
      RAISE EXCEPTION 'the request is not eligible for a return delivery' USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.deliveries
  SET status = 'completed', completed_at = clock_timestamp(), completed_by = p_actor_user_id,
      receipt_reference = p_receipt_reference, notes = left(p_notes, 2000)
  WHERE id = p_delivery_id;

  IF v_delivery.delivery_type = 'offered_book_dropoff' THEN
    UPDATE public.receptions
    SET status = 'received', received_at = clock_timestamp(), received_by = p_actor_user_id
    WHERE id = v_reception.id;
    INSERT INTO public.reception_status_history
      (reception_id, previous_status, new_status, changed_by, reason)
    VALUES
      (v_reception.id, 'awaiting_delivery', 'received', p_actor_user_id, 'dropoff confirmed');
    INSERT INTO public.state_history
      (entity_type, entity_id, previous_state, new_state, changed_by, reason)
    VALUES
      ('reception', v_reception.id, 'awaiting_delivery', 'received', p_actor_user_id, 'dropoff confirmed');
  ELSIF v_delivery.delivery_type = 'offered_book_return' THEN
    UPDATE public.receptions SET status = 'returned' WHERE id = v_reception.id;
    INSERT INTO public.reception_status_history
      (reception_id, previous_status, new_status, changed_by, reason)
    VALUES
      (v_reception.id, 'return_pending', 'returned', p_actor_user_id, 'return confirmed');
    INSERT INTO public.state_history
      (entity_type, entity_id, previous_state, new_state, changed_by, reason)
    VALUES
      ('reception', v_reception.id, 'return_pending', 'returned', p_actor_user_id, 'return confirmed');
  END IF;

  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'delivery.completed', 'delivery', p_delivery_id::TEXT,
     jsonb_build_object('type', v_delivery.delivery_type));

  RETURN p_delivery_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.place_reception_in_custody(
  p_reception_id BIGINT,
  p_actor_user_id BIGINT,
  p_location TEXT,
  p_custodian TEXT,
  p_evidence_reference TEXT,
  p_idempotency_key UUID
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request public.exchange_requests%ROWTYPE;
  v_request_id BIGINT;
  v_exchange_status TEXT;
  v_reception public.receptions%ROWTYPE;
  v_existing public.reception_custody_events%ROWTYPE;
  v_event_id BIGINT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'custody.transfer');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT request_id INTO v_request_id FROM public.receptions WHERE id = p_reception_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reception not found' USING ERRCODE = 'P0002';
  END IF;

  v_request := public.iub_lock_request(v_request_id);
  SELECT status INTO v_exchange_status
  FROM public.exchanges WHERE request_id = v_request_id
  ORDER BY id DESC LIMIT 1 FOR UPDATE;
  IF v_exchange_status IS NULL OR v_exchange_status NOT IN ('planned', 'in_process') THEN
    RAISE EXCEPTION 'custody requires an active exchange' USING ERRCODE = '23514';
  END IF;
  IF v_request.status NOT IN ('scheduled', 'in_process') THEN
    RAISE EXCEPTION 'custody requires an active request' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_reception FROM public.receptions WHERE id = p_reception_id FOR UPDATE;
  SELECT * INTO v_existing FROM public.reception_custody_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_existing.id;
  END IF;

  IF v_reception.status <> 'received' THEN
    RAISE EXCEPTION 'a reception must be received before custody' USING ERRCODE = '23514';
  END IF;
  IF length(trim(coalesce(p_location, ''))) < 1
     OR length(trim(coalesce(p_custodian, ''))) < 1
     OR length(trim(coalesce(p_evidence_reference, ''))) < 1 THEN
    RAISE EXCEPTION 'location, custodian and evidence are required' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.reception_custody_events
    (reception_id, location, custodian, evidence_reference, idempotency_key, recorded_by)
  VALUES
    (p_reception_id, p_location, p_custodian, p_evidence_reference, p_idempotency_key, p_actor_user_id)
  RETURNING id INTO v_event_id;

  UPDATE public.receptions SET status = 'in_custody' WHERE id = p_reception_id;
  INSERT INTO public.reception_status_history
    (reception_id, previous_status, new_status, changed_by, reason)
  VALUES
    (p_reception_id, 'received', 'in_custody', p_actor_user_id, 'custody recorded');
  INSERT INTO public.state_history
    (entity_type, entity_id, previous_state, new_state, changed_by, reason)
  VALUES
    ('reception', p_reception_id, 'received', 'in_custody', p_actor_user_id, 'custody recorded');

  RETURN v_event_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.evaluate_reception(
  p_reception_id BIGINT,
  p_actor_user_id BIGINT,
  p_outcome TEXT,
  p_assessed_condition TEXT,
  p_rationale TEXT,
  p_idempotency_key UUID,
  p_evidence_reference TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request public.exchange_requests%ROWTYPE;
  v_request_id BIGINT;
  v_exchange public.exchanges%ROWTYPE;
  v_reception public.receptions%ROWTYPE;
  v_existing public.book_evaluations%ROWTYPE;
  v_reservation public.reservations%ROWTYPE;
  v_evaluation_id BIGINT;
  v_request_status TEXT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'reception.evaluate');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT request_id INTO v_request_id FROM public.receptions WHERE id = p_reception_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reception not found' USING ERRCODE = 'P0002';
  END IF;

  v_request := public.iub_lock_request(v_request_id);
  SELECT * INTO v_exchange
  FROM public.exchanges WHERE request_id = v_request_id
  ORDER BY id DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exchange not found for reception' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_reception FROM public.receptions WHERE id = p_reception_id FOR UPDATE;

  SELECT * INTO v_existing FROM public.book_evaluations WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.reception_id <> p_reception_id THEN
      RAISE EXCEPTION 'evaluation idempotency key conflict' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.id;
  END IF;

  IF v_reception.status <> 'in_custody' THEN
    RAISE EXCEPTION 'a reception must be in custody before evaluation' USING ERRCODE = '23514';
  END IF;
  IF v_request.status NOT IN ('scheduled', 'in_process') THEN
    RAISE EXCEPTION 'the request is not active for evaluation' USING ERRCODE = '23514';
  END IF;
  IF v_exchange.status NOT IN ('planned', 'in_process') THEN
    RAISE EXCEPTION 'the exchange is not active for evaluation' USING ERRCODE = '23514';
  END IF;
  IF p_outcome NOT IN ('accepted', 'rejected') THEN
    RAISE EXCEPTION 'evaluation outcome must be accepted or rejected' USING ERRCODE = '23514';
  END IF;
  IF p_assessed_condition NOT IN ('excellent', 'good', 'fair', 'poor') THEN
    RAISE EXCEPTION 'assessed condition is invalid' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.book_evaluations
    (reception_id, evaluator_id, outcome, assessed_condition, rationale, is_final, idempotency_key, evidence_reference)
  VALUES
    (p_reception_id, p_actor_user_id, p_outcome, p_assessed_condition, p_rationale, TRUE, p_idempotency_key, p_evidence_reference)
  RETURNING id INTO v_evaluation_id;

  IF p_outcome = 'accepted' THEN
    IF length(trim(coalesce(p_evidence_reference, ''))) < 1 THEN
      RAISE EXCEPTION 'property transfer evidence is required for an accepted book' USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.ownership_transfers
      (reception_id, request_id, participant_id, transferor_type, transferee_type,
       accepted_by, evidence_reference, idempotency_key)
    SELECT v_reception.id, r.id, r.participant_id, 'participant', 'institution',
           p_actor_user_id, p_evidence_reference, md5(p_idempotency_key::TEXT || ':transfer')::UUID
    FROM public.exchange_requests r WHERE r.id = v_reception.request_id;

    UPDATE public.receptions SET status = 'evaluated' WHERE id = p_reception_id;
    INSERT INTO public.reception_status_history
      (reception_id, previous_status, new_status, changed_by, reason)
    VALUES
      (p_reception_id, 'in_custody', 'evaluated', p_actor_user_id, 'evaluation accepted');
    INSERT INTO public.state_history
      (entity_type, entity_id, previous_state, new_state, changed_by, reason)
    VALUES
      ('reception', p_reception_id, 'in_custody', 'evaluated', p_actor_user_id, 'evaluation accepted');
  ELSE
    IF v_exchange.status <> 'planned' THEN
      RAISE EXCEPTION 'a started exchange cannot reject the offered book' USING ERRCODE = '23514';
    END IF;

    UPDATE public.receptions SET status = 'rejected' WHERE id = p_reception_id;
    INSERT INTO public.reception_status_history
      (reception_id, previous_status, new_status, changed_by, reason)
    VALUES
      (p_reception_id, 'in_custody', 'rejected', p_actor_user_id, 'evaluation rejected');
    INSERT INTO public.state_history
      (entity_type, entity_id, previous_state, new_state, changed_by, reason)
    VALUES
      ('reception', p_reception_id, 'in_custody', 'rejected', p_actor_user_id, 'evaluation rejected');

    UPDATE public.exchanges
    SET status = 'cancelled',
        cancellation_idempotency_key = md5(p_idempotency_key::TEXT || ':exchange-cancel')::UUID,
        cancelled_at = clock_timestamp()
    WHERE id = v_exchange.id;
    INSERT INTO public.state_history
      (entity_type, entity_id, previous_state, new_state, changed_by, reason)
    VALUES
      ('exchange', v_exchange.id, 'planned', 'cancelled', p_actor_user_id, 'offered book rejected');

    SELECT * INTO v_reservation
    FROM public.reservations
    WHERE request_id = v_request_id AND status = 'active';

    IF FOUND THEN
      PERFORM 1 FROM public.copies WHERE id = v_reservation.copy_id FOR UPDATE;
      SELECT * INTO v_reservation
      FROM public.reservations
      WHERE id = v_reservation.id
      FOR UPDATE;

      UPDATE public.reservations
      SET status = 'released', released_at = clock_timestamp()
      WHERE id = v_reservation.id;
      UPDATE public.copies
      SET availability = 'available'
      WHERE id = v_reservation.copy_id AND availability = 'reserved';
      INSERT INTO public.inventory_movements
        (copy_id, movement_type, previous_availability, new_availability, reason)
      VALUES
        (v_reservation.copy_id, 'reservation_released', 'reserved', 'available', 'offered book rejected');
    END IF;

    SELECT status INTO v_request_status
    FROM public.exchange_requests WHERE id = v_request_id FOR UPDATE;
    IF v_request_status NOT IN ('scheduled', 'in_process') THEN
      RAISE EXCEPTION 'the request cannot be rejected from status %', v_request_status USING ERRCODE = '23514';
    END IF;
    UPDATE public.exchange_requests SET status = 'rejected' WHERE id = v_request_id;
    INSERT INTO public.request_status_history
      (request_id, previous_status, new_status, changed_by, reason)
    VALUES
      (v_request_id, v_request_status, 'rejected', p_actor_user_id, 'offered book rejected');
    INSERT INTO public.state_history
      (entity_type, entity_id, previous_state, new_state, changed_by, reason)
    VALUES
      ('exchange_request', v_request_id, v_request_status, 'rejected', p_actor_user_id, 'offered book rejected');
  END IF;

  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'reception.evaluated', 'reception', p_reception_id::TEXT,
     jsonb_build_object('outcome', p_outcome, 'evaluation_id', v_evaluation_id));

  RETURN v_evaluation_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.authorize_inventory_admission(
  p_reception_id BIGINT,
  p_actor_user_id BIGINT,
  p_idempotency_key UUID
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request public.exchange_requests%ROWTYPE;
  v_request_id BIGINT;
  v_exchange public.exchanges%ROWTYPE;
  v_reception public.receptions%ROWTYPE;
  v_existing public.inventory_admissions%ROWTYPE;
  v_evaluation public.book_evaluations%ROWTYPE;
  v_cataloging public.cataloging_records%ROWTYPE;
  v_transfer public.ownership_transfers%ROWTYPE;
  v_admission_id BIGINT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'inventory.admit');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT request_id INTO v_request_id FROM public.receptions WHERE id = p_reception_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reception not found' USING ERRCODE = 'P0002';
  END IF;

  v_request := public.iub_lock_request(v_request_id);
  SELECT * INTO v_exchange
  FROM public.exchanges WHERE request_id = v_request_id
  ORDER BY id DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exchange not found for reception' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_reception FROM public.receptions WHERE id = p_reception_id FOR UPDATE;

  SELECT * INTO v_existing FROM public.inventory_admissions WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_existing.id;
  END IF;

  IF v_request.status NOT IN ('scheduled', 'in_process') THEN
    RAISE EXCEPTION 'the request is not active for inventory admission' USING ERRCODE = '23514';
  END IF;
  IF v_exchange.status NOT IN ('planned', 'in_process') THEN
    RAISE EXCEPTION 'the exchange is not active for inventory admission' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.inventory_admissions a WHERE a.reception_id = p_reception_id) THEN
    RAISE EXCEPTION 'an admission already exists for the reception' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO v_evaluation
  FROM public.book_evaluations
  WHERE reception_id = p_reception_id AND is_final
  FOR SHARE;
  IF NOT FOUND OR v_evaluation.outcome <> 'accepted' THEN
    RAISE EXCEPTION 'an accepted final evaluation is required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_cataloging FROM public.cataloging_records WHERE reception_id = p_reception_id FOR SHARE;
  IF NOT FOUND OR v_cataloging.status <> 'authorized' THEN
    RAISE EXCEPTION 'authorized cataloging is required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_transfer FROM public.ownership_transfers WHERE reception_id = p_reception_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an accepted property transfer is required' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.inventory_admissions
    (reception_id, evaluation_id, cataloging_record_id, ownership_transfer_id,
     status, authorized_by, authorized_at, idempotency_key)
  VALUES
    (p_reception_id, v_evaluation.id, v_cataloging.id, v_transfer.id,
     'authorized', p_actor_user_id, clock_timestamp(), p_idempotency_key)
  RETURNING id INTO v_admission_id;

  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'inventory.admission_authorized', 'inventory_admission', v_admission_id::TEXT,
     jsonb_build_object('reception_id', p_reception_id));

  RETURN v_admission_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admit_received_book(
  p_admission_id BIGINT,
  p_inventory_code TEXT,
  p_location TEXT,
  p_actor_user_id BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request public.exchange_requests%ROWTYPE;
  v_request_id BIGINT;
  v_exchange public.exchanges%ROWTYPE;
  v_reception public.receptions%ROWTYPE;
  v_admission public.inventory_admissions%ROWTYPE;
  v_evaluation public.book_evaluations%ROWTYPE;
  v_cataloging public.cataloging_records%ROWTYPE;
  v_transfer public.ownership_transfers%ROWTYPE;
  v_copy_id BIGINT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'inventory.admit');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT * INTO v_admission FROM public.inventory_admissions WHERE id = p_admission_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admission not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_admission.copy_id IS NOT NULL THEN
    RETURN v_admission.copy_id;
  END IF;

  SELECT request_id INTO v_request_id FROM public.receptions WHERE id = v_admission.reception_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reception not found' USING ERRCODE = 'P0002';
  END IF;

  v_request := public.iub_lock_request(v_request_id);
  SELECT * INTO v_exchange
  FROM public.exchanges WHERE request_id = v_request_id
  ORDER BY id DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exchange not found for reception' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_reception FROM public.receptions WHERE id = v_admission.reception_id FOR UPDATE;

  SELECT * INTO v_evaluation FROM public.book_evaluations WHERE id = v_admission.evaluation_id FOR SHARE;
  SELECT * INTO v_cataloging FROM public.cataloging_records WHERE id = v_admission.cataloging_record_id FOR SHARE;
  SELECT * INTO v_transfer FROM public.ownership_transfers WHERE id = v_admission.ownership_transfer_id FOR SHARE;
  SELECT * INTO v_admission FROM public.inventory_admissions WHERE id = p_admission_id FOR UPDATE;

  IF v_admission.copy_id IS NOT NULL THEN
    RETURN v_admission.copy_id;
  END IF;
  IF v_admission.status <> 'authorized' THEN
    RAISE EXCEPTION 'the admission must be authorized before admitting the copy' USING ERRCODE = '23514';
  END IF;
  IF v_request.status NOT IN ('scheduled', 'in_process') THEN
    RAISE EXCEPTION 'the request is not active for inventory admission' USING ERRCODE = '23514';
  END IF;
  IF v_exchange.status NOT IN ('planned', 'in_process') THEN
    RAISE EXCEPTION 'the exchange is not active for inventory admission' USING ERRCODE = '23514';
  END IF;
  IF length(trim(coalesce(p_inventory_code, ''))) < 1 THEN
    RAISE EXCEPTION 'an inventory code is required' USING ERRCODE = '23514';
  END IF;
  IF v_cataloging.bibliographic_record_id IS NULL THEN
    RAISE EXCEPTION 'the cataloging record has no bibliographic record' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.copies
    (bibliographic_record_id, inventory_code, physical_condition, availability, location,
     provenance_type, provenance_reference, source_admission_id, ownership_acquired_at)
  VALUES
    (v_cataloging.bibliographic_record_id, p_inventory_code, v_evaluation.assessed_condition,
     'unavailable', p_location, 'exchange_received',
     'reception:' || v_admission.reception_id::TEXT, v_admission.id, v_transfer.transferred_at)
  RETURNING id INTO v_copy_id;

  UPDATE public.inventory_admissions
  SET copy_id = v_copy_id, status = 'admitted',
      admitted_by = p_actor_user_id, admitted_at = clock_timestamp()
  WHERE id = p_admission_id;
  UPDATE public.cataloging_records SET copy_id = v_copy_id WHERE id = v_admission.cataloging_record_id;

  INSERT INTO public.inventory_movements
    (copy_id, movement_type, new_availability, performed_by, reason)
  VALUES
    (v_copy_id, 'received', 'unavailable', p_actor_user_id, 'admitted from participant exchange');

  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'inventory.copy_admitted', 'copy', v_copy_id::TEXT,
     jsonb_build_object('admission_id', p_admission_id));

  RETURN v_copy_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enable_received_copy(p_admission_id BIGINT, p_actor_user_id BIGINT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request public.exchange_requests%ROWTYPE;
  v_request_id BIGINT;
  v_exchange public.exchanges%ROWTYPE;
  v_reception public.receptions%ROWTYPE;
  v_admission public.inventory_admissions%ROWTYPE;
  v_copy public.copies%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'inventory.enable');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT * INTO v_admission FROM public.inventory_admissions WHERE id = p_admission_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admission not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_admission.status = 'enabled' THEN
    RETURN v_admission.copy_id;
  END IF;

  SELECT request_id INTO v_request_id FROM public.receptions WHERE id = v_admission.reception_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reception not found' USING ERRCODE = 'P0002';
  END IF;

  v_request := public.iub_lock_request(v_request_id);
  SELECT * INTO v_exchange
  FROM public.exchanges WHERE request_id = v_request_id
  ORDER BY id DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exchange not found for reception' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_reception FROM public.receptions WHERE id = v_admission.reception_id FOR UPDATE;
  SELECT * INTO v_admission FROM public.inventory_admissions WHERE id = p_admission_id FOR UPDATE;

  IF v_admission.status = 'enabled' THEN
    RETURN v_admission.copy_id;
  END IF;
  IF v_admission.status <> 'admitted' OR v_admission.copy_id IS NULL THEN
    RAISE EXCEPTION 'the admission must be admitted before enabling the copy' USING ERRCODE = '23514';
  END IF;
  IF v_request.status NOT IN ('scheduled', 'in_process') THEN
    RAISE EXCEPTION 'the request is not active for inventory enablement' USING ERRCODE = '23514';
  END IF;
  IF v_exchange.status NOT IN ('planned', 'in_process') THEN
    RAISE EXCEPTION 'the exchange is not active for inventory enablement' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_copy FROM public.copies WHERE id = v_admission.copy_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copy not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_copy.availability <> 'unavailable' THEN
    RAISE EXCEPTION 'the offered copy cannot be available before exchange completion' USING ERRCODE = '23514';
  END IF;
  IF v_copy.provenance_type <> 'exchange_received'
     OR v_copy.source_admission_id IS DISTINCT FROM v_admission.id THEN
    RAISE EXCEPTION 'the copy does not belong to the admission' USING ERRCODE = '23514';
  END IF;

  UPDATE public.inventory_admissions
  SET status = 'enabled', enabled_by = p_actor_user_id, enabled_at = clock_timestamp()
  WHERE id = p_admission_id;

  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'inventory.copy_enabled', 'inventory_admission', p_admission_id::TEXT,
     jsonb_build_object('copy_id', v_admission.copy_id));

  RETURN v_admission.copy_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Exchange lifecycle, completion and compensated cancellation
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.start_exchange(p_exchange_id BIGINT, p_actor_user_id BIGINT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request public.exchange_requests%ROWTYPE;
  v_request_id BIGINT;
  v_exchange public.exchanges%ROWTYPE;
  v_reception public.receptions%ROWTYPE;
  v_admission public.inventory_admissions%ROWTYPE;
  v_copy public.copies%ROWTYPE;
  v_reservation public.reservations%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'exchange.start');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT request_id INTO v_request_id FROM public.exchanges WHERE id = p_exchange_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exchange not found' USING ERRCODE = 'P0002';
  END IF;

  v_request := public.iub_lock_request(v_request_id);
  SELECT * INTO v_exchange FROM public.exchanges WHERE id = p_exchange_id FOR UPDATE;

  IF v_exchange.status = 'in_process' THEN
    RETURN v_exchange.id;
  END IF;
  IF v_exchange.status <> 'planned' THEN
    RAISE EXCEPTION 'exchange cannot be started' USING ERRCODE = '23514';
  END IF;
  IF v_request.status <> 'scheduled' THEN
    RAISE EXCEPTION 'request must be scheduled' USING ERRCODE = '23514';
  END IF;
  IF v_exchange.offered_reception_id IS NULL THEN
    RAISE EXCEPTION 'the exchange has no offered reception' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_reception FROM public.receptions WHERE id = v_exchange.offered_reception_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offered reception not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_admission
  FROM public.inventory_admissions
  WHERE reception_id = v_exchange.offered_reception_id
  FOR UPDATE;
  IF NOT FOUND OR v_admission.status <> 'enabled' OR v_admission.copy_id IS NULL THEN
    RAISE EXCEPTION 'the offered book must be admitted and enabled before starting' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_copy FROM public.copies WHERE id = v_admission.copy_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offered copy not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_copy.availability <> 'unavailable'
     OR v_copy.provenance_type <> 'exchange_received'
     OR v_copy.source_admission_id IS DISTINCT FROM v_admission.id THEN
    RAISE EXCEPTION 'the offered copy is not ready for exchange completion' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_reservation
  FROM public.reservations
  WHERE request_id = v_request_id AND copy_id = v_exchange.institutional_copy_id
    AND status = 'active' AND expires_at > clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an active reservation is required to start the exchange' USING ERRCODE = '23514';
  END IF;

  UPDATE public.reservations
  SET status = 'converted', released_at = clock_timestamp()
  WHERE id = v_reservation.id;
  UPDATE public.exchanges
  SET status = 'in_process',
      offered_admission_id = v_admission.id,
      offered_copy_id = v_admission.copy_id
  WHERE id = p_exchange_id;
  UPDATE public.exchange_requests SET status = 'in_process' WHERE id = v_request_id;

  INSERT INTO public.request_status_history
    (request_id, previous_status, new_status, changed_by, reason)
  VALUES
    (v_request_id, 'scheduled', 'in_process', p_actor_user_id, 'exchange started');
  INSERT INTO public.state_history
    (entity_type, entity_id, previous_state, new_state, changed_by, reason)
  VALUES
    ('exchange', p_exchange_id, 'planned', 'in_process', p_actor_user_id, 'exchange started'),
    ('exchange_request', v_request_id, 'scheduled', 'in_process', p_actor_user_id, 'exchange started');
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'exchange.started', 'exchange', p_exchange_id::TEXT,
     jsonb_build_object('request_id', v_request_id));

  RETURN p_exchange_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_exchange(
  p_exchange_id BIGINT,
  p_completion_key UUID,
  p_actor_user_id BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request public.exchange_requests%ROWTYPE;
  v_request_id BIGINT;
  v_exchange public.exchanges%ROWTYPE;
  v_reception public.receptions%ROWTYPE;
  v_admission public.inventory_admissions%ROWTYPE;
  v_evaluation public.book_evaluations%ROWTYPE;
  v_cataloging public.cataloging_records%ROWTYPE;
  v_reservation public.reservations%ROWTYPE;
  v_institutional public.copies%ROWTYPE;
  v_offered public.copies%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'exchange.complete');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT request_id INTO v_request_id FROM public.exchanges WHERE id = p_exchange_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exchange not found' USING ERRCODE = 'P0002';
  END IF;

  v_request := public.iub_lock_request(v_request_id);
  SELECT * INTO v_exchange FROM public.exchanges WHERE id = p_exchange_id FOR UPDATE;

  IF v_exchange.status = 'completed' THEN
    IF v_exchange.completion_idempotency_key = p_completion_key THEN
      RETURN v_exchange.id;
    END IF;
    RAISE EXCEPTION 'exchange already completed with a different idempotency key' USING ERRCODE = '23505';
  END IF;
  IF v_exchange.status <> 'in_process' OR v_request.status <> 'in_process' THEN
    RAISE EXCEPTION 'exchange is not in process' USING ERRCODE = '23514';
  END IF;
  IF v_exchange.offered_reception_id IS NULL OR v_exchange.offered_copy_id IS NULL THEN
    RAISE EXCEPTION 'the exchange has no offered book' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_reception FROM public.receptions WHERE id = v_exchange.offered_reception_id FOR UPDATE;

  SELECT * INTO v_evaluation
  FROM public.book_evaluations
  WHERE reception_id = v_exchange.offered_reception_id AND is_final
  FOR SHARE;
  IF NOT FOUND OR v_evaluation.outcome <> 'accepted' THEN
    RAISE EXCEPTION 'an accepted final evaluation is required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_cataloging
  FROM public.cataloging_records
  WHERE reception_id = v_exchange.offered_reception_id
  FOR SHARE;
  IF NOT FOUND OR v_cataloging.status <> 'authorized' THEN
    RAISE EXCEPTION 'authorized cataloging is required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_admission
  FROM public.inventory_admissions
  WHERE reception_id = v_exchange.offered_reception_id
  FOR UPDATE;
  IF NOT FOUND OR v_admission.status <> 'enabled' OR v_admission.copy_id IS NULL THEN
    RAISE EXCEPTION 'physical receipt, accepted evaluation, and property transfer are required' USING ERRCODE = '23514';
  END IF;
  IF v_exchange.offered_admission_id IS NOT NULL
     AND v_exchange.offered_admission_id <> v_admission.id THEN
    RAISE EXCEPTION 'the offered admission does not match the exchange' USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.copies
  WHERE id IN (v_exchange.institutional_copy_id, v_exchange.offered_copy_id)
  ORDER BY id
  FOR UPDATE;

  SELECT * INTO v_institutional FROM public.copies WHERE id = v_exchange.institutional_copy_id;
  SELECT * INTO v_offered FROM public.copies WHERE id = v_exchange.offered_copy_id;
  IF v_institutional.id IS NULL OR v_institutional.availability <> 'reserved' THEN
    RAISE EXCEPTION 'the institutional copy is not reserved' USING ERRCODE = '23514';
  END IF;
  IF v_offered.id IS NULL
     OR v_offered.availability <> 'unavailable'
     OR v_offered.provenance_type <> 'exchange_received'
     OR v_offered.source_admission_id IS DISTINCT FROM v_admission.id THEN
    RAISE EXCEPTION 'the offered admitted copy is not ready for completion' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_reservation
  FROM public.reservations
  WHERE request_id = v_request_id AND copy_id = v_exchange.institutional_copy_id
    AND status = 'converted'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the in-process exchange reservation hold is required at handover' USING ERRCODE = '23514';
  END IF;

  IF (
    SELECT count(*) FROM public.deliveries d
    WHERE d.exchange_id = p_exchange_id AND d.request_id = v_request_id
      AND d.reception_id = v_exchange.offered_reception_id
      AND d.status = 'completed' AND d.completed_at IS NOT NULL AND d.completed_by IS NOT NULL
      AND d.receipt_reference IS NOT NULL
      AND d.delivery_type IN ('offered_book_dropoff', 'institutional_copy_handover')
  ) <> 2 THEN
    RAISE EXCEPTION 'confirmed and documented receipt and institutional handover are required' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.inventory_movements
    (copy_id, exchange_id, reception_id, movement_type, previous_availability, new_availability,
     idempotency_key, performed_by, reason)
  VALUES
    (v_exchange.institutional_copy_id, p_exchange_id, v_exchange.offered_reception_id,
     'exchange_out', 'reserved', 'retired', p_completion_key, p_actor_user_id, 'documented exchange handover'),
    (v_exchange.offered_copy_id, p_exchange_id, v_exchange.offered_reception_id,
     'exchange_in', 'unavailable', 'available', md5(p_completion_key::TEXT || ':in')::UUID,
     p_actor_user_id, 'received offered book');

  PERFORM set_config('app.exchange_completion', 'on', TRUE);
  UPDATE public.copies SET availability = 'retired' WHERE id = v_exchange.institutional_copy_id;
  UPDATE public.copies SET availability = 'available' WHERE id = v_exchange.offered_copy_id;
  PERFORM set_config('app.exchange_completion', '', TRUE);

  UPDATE public.exchanges
  SET status = 'completed', completed_at = clock_timestamp(), completion_idempotency_key = p_completion_key
  WHERE id = p_exchange_id;
  UPDATE public.exchange_requests SET status = 'completed' WHERE id = v_request_id;

  INSERT INTO public.request_status_history
    (request_id, previous_status, new_status, changed_by, reason)
  VALUES
    (v_request_id, 'in_process', 'completed', p_actor_user_id, 'exchange completed');
  INSERT INTO public.state_history
    (entity_type, entity_id, previous_state, new_state, changed_by, reason)
  VALUES
    ('exchange', p_exchange_id, 'in_process', 'completed', p_actor_user_id, 'exchange completed'),
    ('exchange_request', v_request_id, 'in_process', 'completed', p_actor_user_id, 'exchange completed');
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'exchange.completed', 'exchange', p_exchange_id::TEXT,
     jsonb_build_object('request_id', v_request_id));

  RETURN p_exchange_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_exchange(
  p_exchange_id BIGINT,
  p_cancellation_key UUID,
  p_actor_user_id BIGINT,
  p_reason TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request public.exchange_requests%ROWTYPE;
  v_request_id BIGINT;
  v_exchange public.exchanges%ROWTYPE;
  v_reception public.receptions%ROWTYPE;
  v_evaluation public.book_evaluations%ROWTYPE;
  v_transfer public.ownership_transfers%ROWTYPE;
  v_reversal public.ownership_transfer_reversals%ROWTYPE;
  v_admission public.inventory_admissions%ROWTYPE;
  v_institutional public.copies%ROWTYPE;
  v_offered public.copies%ROWTYPE;
  v_reservation public.reservations%ROWTYPE;
  v_return_delivery public.deliveries%ROWTYPE;
  v_physical_received BOOLEAN := FALSE;
  v_transfer_exists BOOLEAN := FALSE;
  v_return_required BOOLEAN := FALSE;
  v_previous_exchange_status TEXT;
  v_previous_request_status TEXT;
  v_reason TEXT;
  v_reversal_id BIGINT;
BEGIN
  IF p_cancellation_key IS NULL THEN
    RAISE EXCEPTION 'a cancellation idempotency key is required' USING ERRCODE = '23502';
  END IF;

  PERFORM public.assert_actor_permission(p_actor_user_id, 'exchange.cancel');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT request_id INTO v_request_id FROM public.exchanges WHERE id = p_exchange_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exchange not found' USING ERRCODE = 'P0002';
  END IF;

  v_request := public.iub_lock_request(v_request_id);
  SELECT * INTO v_exchange FROM public.exchanges WHERE id = p_exchange_id FOR UPDATE;

  IF v_exchange.status = 'cancelled' THEN
    IF v_exchange.cancellation_idempotency_key = p_cancellation_key THEN
      RETURN v_exchange.id;
    END IF;
    RAISE EXCEPTION 'exchange already cancelled with a different idempotency key' USING ERRCODE = '23505';
  END IF;
  IF v_exchange.status = 'completed' THEN
    RAISE EXCEPTION 'a completed exchange cannot be cancelled' USING ERRCODE = '23514';
  END IF;
  IF v_exchange.status NOT IN ('planned', 'in_process', 'cancellation_pending') THEN
    RAISE EXCEPTION 'exchange cannot be cancelled from status %', v_exchange.status USING ERRCODE = '23514';
  END IF;
  IF v_exchange.status = 'cancellation_pending'
     AND v_exchange.cancellation_idempotency_key IS DISTINCT FROM p_cancellation_key THEN
    RAISE EXCEPTION 'cancellation idempotency key mismatch' USING ERRCODE = '23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.deliveries d
    WHERE d.exchange_id = p_exchange_id
      AND d.delivery_type = 'institutional_copy_handover' AND d.status = 'completed'
  ) THEN
    RAISE EXCEPTION 'a confirmed institutional handover must be completed, not cancelled' USING ERRCODE = '23514';
  END IF;

  IF v_exchange.offered_reception_id IS NOT NULL THEN
    SELECT * INTO v_reception FROM public.receptions WHERE id = v_exchange.offered_reception_id FOR UPDATE;
    SELECT * INTO v_evaluation
    FROM public.book_evaluations
    WHERE reception_id = v_exchange.offered_reception_id AND is_final
    FOR SHARE;
    SELECT * INTO v_transfer
    FROM public.ownership_transfers
    WHERE reception_id = v_exchange.offered_reception_id
    FOR SHARE;
    SELECT * INTO v_admission
    FROM public.inventory_admissions
    WHERE reception_id = v_exchange.offered_reception_id
    FOR UPDATE;
  END IF;

  IF v_transfer.id IS NOT NULL THEN
    SELECT * INTO v_reversal
    FROM public.ownership_transfer_reversals
    WHERE transfer_id = v_transfer.id;
  END IF;

  v_physical_received := v_reception.id IS NOT NULL
    AND v_reception.status IN ('received', 'in_custody', 'evaluated', 'accepted', 'return_pending');
  v_transfer_exists := v_transfer.id IS NOT NULL;
  v_return_required := (v_physical_received OR v_transfer_exists)
    AND (v_reception.id IS NULL OR v_reception.status <> 'returned');

  IF v_admission.id IS NOT NULL AND NOT v_transfer_exists THEN
    RAISE EXCEPTION 'an inventory admission exists without an ownership transfer' USING ERRCODE = '23514';
  END IF;

  IF v_exchange.status = 'cancellation_pending' THEN
    IF v_return_required THEN
      RAISE EXCEPTION 'cancellation is pending physical return confirmation' USING ERRCODE = '55000';
    END IF;
  ELSE
    IF v_request.status NOT IN ('scheduled', 'in_process') THEN
      RAISE EXCEPTION 'only an active request can be cancelled' USING ERRCODE = '23514';
    END IF;

    IF v_return_required THEN
      UPDATE public.exchanges
      SET status = 'cancellation_pending',
          cancellation_idempotency_key = p_cancellation_key,
          cancellation_pending_at = clock_timestamp()
      WHERE id = p_exchange_id;

      UPDATE public.exchange_requests SET status = 'cancellation_pending' WHERE id = v_request_id;

      IF v_reception.status <> 'return_pending' THEN
        UPDATE public.receptions SET status = 'return_pending' WHERE id = v_reception.id;
        INSERT INTO public.reception_status_history
          (reception_id, previous_status, new_status, changed_by, reason)
        VALUES
          (v_reception.id, v_reception.status, 'return_pending', p_actor_user_id,
           left(coalesce(nullif(trim(p_reason), ''), 'cancellation requires physical return'), 3000));
        INSERT INTO public.state_history
          (entity_type, entity_id, previous_state, new_state, changed_by, reason)
        VALUES
          ('reception', v_reception.id, v_reception.status, 'return_pending', p_actor_user_id,
           left(coalesce(nullif(trim(p_reason), ''), 'cancellation requires physical return'), 3000));
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM public.deliveries d
        WHERE d.exchange_id = p_exchange_id AND d.delivery_type = 'offered_book_return'
          AND d.status IN ('scheduled', 'in_progress', 'completed')
      ) THEN
        INSERT INTO public.deliveries
          (request_id, reception_id, exchange_id, delivery_type, status, scheduled_at,
           recorded_by, idempotency_key)
        VALUES
          (v_request_id, v_reception.id, p_exchange_id, 'offered_book_return', 'scheduled',
           clock_timestamp(), p_actor_user_id, md5(p_cancellation_key::TEXT || ':return')::UUID);
      END IF;

      INSERT INTO public.request_status_history
        (request_id, previous_status, new_status, changed_by, reason)
      VALUES
        (v_request_id, v_request.status, 'cancellation_pending', p_actor_user_id,
         left(coalesce(p_reason, ''), 3000));
      INSERT INTO public.state_history
        (entity_type, entity_id, previous_state, new_state, changed_by, reason)
      VALUES
        ('exchange', p_exchange_id, v_exchange.status, 'cancellation_pending', p_actor_user_id,
         left(coalesce(p_reason, ''), 3000)),
        ('exchange_request', v_request_id, v_request.status, 'cancellation_pending', p_actor_user_id,
         left(coalesce(p_reason, ''), 3000));
      INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
      VALUES
        (p_actor_user_id, 'exchange.cancellation_pending', 'exchange', p_exchange_id::TEXT,
         jsonb_build_object('request_id', v_request_id, 'reason', left(coalesce(p_reason, ''), 2000)));

      RETURN p_exchange_id;
    END IF;
  END IF;

  IF v_return_required THEN
    RAISE EXCEPTION 'cancellation is pending physical return confirmation' USING ERRCODE = '55000';
  END IF;

  v_previous_exchange_status := v_exchange.status;
  v_previous_request_status := v_request.status;
  v_reason := left(coalesce(nullif(trim(p_reason), ''), 'exchange cancelled'), 3000);

  IF v_transfer_exists AND v_reversal.id IS NULL THEN
    IF v_reception.status <> 'returned' THEN
      RAISE EXCEPTION 'the participant book must be physically returned before cancellation' USING ERRCODE = '23514';
    END IF;

    SELECT * INTO v_return_delivery
    FROM public.deliveries
    WHERE exchange_id = p_exchange_id AND delivery_type = 'offered_book_return'
      AND status = 'completed' AND receipt_reference IS NOT NULL
    ORDER BY completed_at DESC NULLS LAST
    LIMIT 1
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a confirmed return with evidence is required before cancellation' USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.ownership_transfer_reversals
      (transfer_id, return_delivery_id, reversed_by, reason, evidence_reference, idempotency_key)
    VALUES
      (v_transfer.id, v_return_delivery.id, p_actor_user_id, v_reason,
       v_return_delivery.receipt_reference, md5(p_cancellation_key::TEXT || ':reversal')::UUID)
    RETURNING id INTO v_reversal_id;

    IF v_admission.id IS NOT NULL THEN
      UPDATE public.inventory_admissions
      SET status = 'reversed', reversed_by = p_actor_user_id, reversed_at = clock_timestamp()
      WHERE id = v_admission.id;

      IF v_admission.copy_id IS NOT NULL THEN
        SELECT * INTO v_offered FROM public.copies WHERE id = v_admission.copy_id FOR UPDATE;
        IF v_offered.availability <> 'retired' THEN
          UPDATE public.copies SET availability = 'retired' WHERE id = v_offered.id;
          INSERT INTO public.inventory_movements
            (copy_id, exchange_id, reception_id, movement_type, previous_availability,
             new_availability, performed_by, reason)
          VALUES
            (v_offered.id, p_exchange_id, v_exchange.offered_reception_id, 'retired',
             v_offered.availability, 'retired', p_actor_user_id,
             'offered copy retired after confirmed physical return');
        END IF;
      END IF;
    END IF;
  ELSIF v_physical_received AND v_reception.status <> 'returned' THEN
    RAISE EXCEPTION 'the participant book must be physically returned before cancellation' USING ERRCODE = '23514';
  END IF;

  UPDATE public.deliveries
  SET status = 'cancelled'
  WHERE exchange_id = p_exchange_id AND status IN ('scheduled', 'in_progress');

  IF v_exchange.institutional_copy_id IS NOT NULL THEN
    SELECT * INTO v_institutional FROM public.copies WHERE id = v_exchange.institutional_copy_id FOR UPDATE;

    SELECT * INTO v_reservation
    FROM public.reservations
    WHERE request_id = v_request_id AND copy_id = v_exchange.institutional_copy_id
      AND status IN ('active', 'converted')
    FOR UPDATE;

    IF NOT FOUND AND v_institutional.availability = 'reserved' THEN
      RAISE EXCEPTION 'the institutional reservation hold was not found' USING ERRCODE = '23514';
    END IF;

    IF FOUND THEN
      UPDATE public.reservations
      SET status = 'released', released_at = clock_timestamp()
      WHERE id = v_reservation.id;
    END IF;

    IF v_institutional.availability = 'reserved' THEN
      UPDATE public.copies SET availability = 'available' WHERE id = v_institutional.id;
      INSERT INTO public.inventory_movements
        (copy_id, exchange_id, reception_id, movement_type, previous_availability,
         new_availability, idempotency_key, performed_by, reason)
      VALUES
        (v_institutional.id, p_exchange_id, v_exchange.offered_reception_id,
         'reservation_released', 'reserved', 'available', p_cancellation_key,
         p_actor_user_id, v_reason);
    END IF;
  END IF;

  IF v_reception.id IS NOT NULL AND v_reception.status = 'awaiting_delivery' THEN
    UPDATE public.receptions SET status = 'cancelled' WHERE id = v_reception.id;
    INSERT INTO public.reception_status_history
      (reception_id, previous_status, new_status, changed_by, reason)
    VALUES
      (v_reception.id, 'awaiting_delivery', 'cancelled', p_actor_user_id, v_reason);
    INSERT INTO public.state_history
      (entity_type, entity_id, previous_state, new_state, changed_by, reason)
    VALUES
      ('reception', v_reception.id, 'awaiting_delivery', 'cancelled', p_actor_user_id, v_reason);
  END IF;

  UPDATE public.exchanges
  SET status = 'cancelled', cancellation_idempotency_key = p_cancellation_key,
      cancelled_at = clock_timestamp()
  WHERE id = p_exchange_id;
  UPDATE public.exchange_requests SET status = 'cancelled' WHERE id = v_request_id;

  INSERT INTO public.request_status_history
    (request_id, previous_status, new_status, changed_by, reason)
  VALUES
    (v_request_id, v_previous_request_status, 'cancelled', p_actor_user_id, v_reason);
  INSERT INTO public.state_history
    (entity_type, entity_id, previous_state, new_state, changed_by, reason)
  VALUES
    ('exchange', p_exchange_id, v_previous_exchange_status, 'cancelled', p_actor_user_id, v_reason),
    ('exchange_request', v_request_id, v_previous_request_status, 'cancelled', p_actor_user_id, v_reason);
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'exchange.cancelled', 'exchange', p_exchange_id::TEXT,
     jsonb_build_object(
       'request_id', v_request_id,
       'reason', left(coalesce(p_reason, ''), 2000),
       'compensated', v_transfer_exists,
       'transfer_reversal_id', v_reversal_id,
       'return_delivery_id', v_return_delivery.id
     ));

  RETURN p_exchange_id;
END;
$function$;
