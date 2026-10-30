-- One-time, guarded repair for the real request that was approved after its
-- reservation had already expired. It does not recreate or delete any copy.
-- It only re-commits the existing hold for the exact request/copy pair and
-- records the reason in inventory_movements and audit_events.
--
-- Safe to run repeatedly: every UPDATE is conditional on the exact legacy
-- state (approved request + expired reservation + available copy).

DO $repair$
DECLARE
  v_request public.exchange_requests%ROWTYPE;
  v_reservation public.reservations%ROWTYPE;
  v_copy public.copies%ROWTYPE;
  v_previous_status TEXT;
BEGIN
  SELECT * INTO v_request
  FROM public.exchange_requests
  WHERE request_code = 'IUB-2026-0E04340C'
    AND status = 'approved';

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO v_reservation
  FROM public.reservations
  WHERE request_id = v_request.id
    AND copy_id = v_request.requested_copy_id
  ORDER BY id DESC
  LIMIT 1;

  IF NOT FOUND OR v_reservation.status <> 'expired' THEN
    RETURN;
  END IF;
  v_previous_status := v_reservation.status;

  SELECT * INTO v_copy
  FROM public.copies
  WHERE id = v_request.requested_copy_id
  FOR UPDATE;

  IF NOT FOUND OR v_copy.availability <> 'available' THEN
    RETURN;
  END IF;

  UPDATE public.reservations
  SET status = 'converted', released_at = coalesce(released_at, clock_timestamp())
  WHERE id = v_reservation.id;

  UPDATE public.copies
  SET availability = 'reserved'
  WHERE id = v_copy.id;

  INSERT INTO public.inventory_movements
    (copy_id, movement_type, previous_availability, new_availability, reason)
  VALUES
    (v_copy.id, 'availability_changed', 'available', 'reserved',
     'approved request repair: expired reservation re-committed');

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (NULL, 'reservation.repaired_after_approval', 'reservation', v_reservation.id::TEXT,
     jsonb_build_object(
       'request_id', v_request.id,
       'request_code', v_request.request_code,
       'copy_id', v_copy.id,
       'inventory_code', v_copy.inventory_code,
       'previous_reservation_status', v_previous_status,
       'new_reservation_status', 'converted',
       'reason', 'approval occurred after reservation expiry; copy re-committed'
     ));
END;
$repair$;
