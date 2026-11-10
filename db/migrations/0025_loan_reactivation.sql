-- 0025_loan_reactivation.sql
--
-- Reactivación autorizada de préstamos cancelados. Es aditiva y contigua a
-- 0024: añade el permiso, la clave de idempotencia y la rutina transaccional;
-- no borra préstamos, eventos de cancelación ni historiales.

DO $precondition$
BEGIN
  IF to_regclass('public.loans') IS NULL
     OR to_regclass('public.loan_events') IS NULL
     OR to_regclass('public.reservations') IS NULL
     OR to_regclass('public.exchange_requests') IS NULL
     OR to_regclass('public.exchanges') IS NULL
     OR to_regprocedure('public.assert_actor_permission(bigint,text)') IS NULL THEN
    RAISE EXCEPTION '0025 requires the 0024 loan history baseline'
      USING ERRCODE = '55000';
  END IF;
END
$precondition$;

INSERT INTO public.permissions (permission_key, description) VALUES
  ('loans.reactivate', 'Reactivar préstamos cancelados con motivo auditable')
ON CONFLICT (permission_key) DO NOTHING;

-- Propaga el permiso a los roles que ya pueden cerrar o cancelar trueques.
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, target.id
FROM public.role_permissions rp
JOIN public.permissions source ON source.id = rp.permission_id
JOIN public.permissions target ON target.permission_key = 'loans.reactivate'
WHERE source.permission_key IN ('exchange.cancel', 'requests.review')
ON CONFLICT (role_id, permission_id) DO NOTHING;

ALTER TABLE public.loans
  ADD COLUMN reactivation_key UUID,
  ADD COLUMN reactivated_at TIMESTAMPTZ,
  ADD COLUMN reactivated_by BIGINT REFERENCES public.app_users(id),
  ADD COLUMN reactivation_reason TEXT;

CREATE UNIQUE INDEX loans_reactivation_key_uidx
  ON public.loans (reactivation_key)
  WHERE reactivation_key IS NOT NULL;

COMMENT ON COLUMN public.loans.reactivation_key IS
  'Clave de idempotencia de la reactivación autorizada; NULL si no se ha reactivado.';

CREATE OR REPLACE FUNCTION public.reactivate_cancelled_loan(
  p_loan_id BIGINT,
  p_reason TEXT,
  p_idempotency_key UUID,
  p_actor_user_id BIGINT
)
RETURNS TABLE (
  loan_id BIGINT,
  status TEXT,
  request_id BIGINT,
  reservation_id BIGINT,
  copy_id BIGINT,
  due_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_loan public.loans%ROWTYPE;
  v_request public.exchange_requests%ROWTYPE;
  v_exchange public.exchanges%ROWTYPE;
  v_reception public.receptions%ROWTYPE;
  v_offered_copy public.copies%ROWTYPE;
  v_copy public.copies%ROWTYPE;
  v_reservation public.reservations%ROWTYPE;
  v_reopen_exchange BOOLEAN := FALSE;
  v_new_status TEXT;
  v_reason TEXT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'loans.reactivate');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '23502';
  END IF;
  v_reason := left(btrim(coalesce(p_reason, '')), 3000);
  IF length(v_reason) < 3 THEN
    RAISE EXCEPTION 'a reactivation reason is required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_loan
  FROM public.loans l
  WHERE l.id = p_loan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'loan not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_loan.reactivation_key IS NOT NULL THEN
    IF v_loan.reactivation_key = p_idempotency_key THEN
      loan_id := v_loan.id;
      status := v_loan.status;
      request_id := v_loan.request_id;
      reservation_id := v_loan.reservation_id;
      copy_id := v_loan.copy_id;
      due_at := v_loan.due_at;
      RETURN NEXT;
      RETURN;
    END IF;
    RAISE EXCEPTION 'the loan was reactivated with a different idempotency key'
      USING ERRCODE = '23505';
  END IF;

  IF v_loan.status <> 'cancelled' THEN
    RAISE EXCEPTION 'only cancelled loans can be reactivated' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_request
  FROM public.exchange_requests r
  WHERE r.id = v_loan.request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'request not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_request.status <> 'cancelled' THEN
    RAISE EXCEPTION 'the related request is not eligible to continue'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.deliveries d
    WHERE d.request_id = v_loan.request_id
      AND d.delivery_type = 'offered_book_return'
      AND d.status IN ('scheduled', 'in_progress', 'completed')
  ) THEN
    RAISE EXCEPTION 'the cancelled loan has a pending or confirmed physical return'
      USING ERRCODE = '23514';
  END IF;

  IF v_loan.exchange_id IS NOT NULL THEN
    SELECT * INTO v_exchange
    FROM public.exchanges e
    WHERE e.id = v_loan.exchange_id
    FOR UPDATE;

    IF NOT FOUND OR v_exchange.status <> 'cancelled' THEN
      RAISE EXCEPTION 'the related exchange is not eligible for reactivation'
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.deliveries d
      WHERE d.exchange_id = v_exchange.id
        AND (
          d.status = 'completed'
          OR (
            d.delivery_type IN ('offered_book_return', 'institutional_copy_handover')
            AND d.status IN ('scheduled', 'in_progress')
          )
        )
    ) THEN
      RAISE EXCEPTION 'the cancelled loan has an incompatible or pending physical delivery'
        USING ERRCODE = '23514';
    END IF;

    IF v_exchange.offered_reception_id IS NOT NULL THEN
      SELECT * INTO v_reception
      FROM public.receptions r
      WHERE r.id = v_exchange.offered_reception_id
      FOR UPDATE;

      IF FOUND AND v_reception.status NOT IN ('awaiting_delivery', 'cancelled') THEN
        RAISE EXCEPTION 'the related reception is returned or pending return'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF v_exchange.offered_copy_id IS NOT NULL THEN
      SELECT * INTO v_offered_copy
      FROM public.copies c
      WHERE c.id = v_exchange.offered_copy_id
      FOR UPDATE;

      IF FOUND AND v_offered_copy.availability = 'retired' THEN
        RAISE EXCEPTION 'the offered copy was permanently retired by the previous flow'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.ownership_transfer_reversals otrx
      JOIN public.ownership_transfers ot ON ot.id = otrx.transfer_id
      WHERE ot.reception_id = v_exchange.offered_reception_id
    ) THEN
      RAISE EXCEPTION 'the previous physical flow was irreversibly reversed'
        USING ERRCODE = '23514';
    END IF;

    v_reopen_exchange := TRUE;
  END IF;

  SELECT * INTO v_copy
  FROM public.copies c
  WHERE c.id = v_loan.copy_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'copy not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_copy.availability = 'retired' THEN
    RAISE EXCEPTION 'a retired copy cannot be reactivated' USING ERRCODE = '23514';
  END IF;
  IF v_copy.availability NOT IN ('available', 'reserved') THEN
    RAISE EXCEPTION 'the copy is not available or reserved for this request'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.reservations r
    WHERE r.copy_id = v_loan.copy_id
      AND r.request_id <> v_loan.request_id
      AND r.status IN ('active', 'converted')
  ) THEN
    RAISE EXCEPTION 'the copy already has another active reservation'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.loans l
    WHERE l.copy_id = v_loan.copy_id
      AND l.id <> v_loan.id
      AND l.status NOT IN ('completed', 'cancelled', 'expired')
  ) THEN
    RAISE EXCEPTION 'the copy already has another active loan'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_reservation
  FROM public.reservations r
  WHERE r.id = v_loan.reservation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'the loan reservation was not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_reservation.status NOT IN ('released', 'expired', 'active') THEN
    RAISE EXCEPTION 'the previous reservation cannot be restored'
      USING ERRCODE = '23514';
  END IF;

  IF v_reservation.status = 'active' THEN
    UPDATE public.reservations
    SET expires_at = greatest(
          expires_at,
          created_at + interval '48 hours'
        )
    WHERE id = v_reservation.id;
  ELSE
    UPDATE public.reservations
    SET status = 'active',
        created_at = clock_timestamp(),
        expires_at = clock_timestamp() + interval '48 hours',
        released_at = NULL
    WHERE id = v_reservation.id;
  END IF;

  SELECT * INTO v_reservation
  FROM public.reservations r
  WHERE r.id = v_reservation.id;

  IF v_copy.availability = 'available' THEN
    UPDATE public.copies
    SET availability = 'reserved'
    WHERE id = v_copy.id;

    INSERT INTO public.inventory_movements
      (copy_id, movement_type, previous_availability, new_availability,
       idempotency_key, performed_by, reason)
    VALUES
      (v_copy.id, 'reserved', 'available', 'reserved',
       md5(p_idempotency_key::TEXT || ':reactivate')::UUID, p_actor_user_id,
       'cancelled loan reactivated');
  END IF;

  IF v_reopen_exchange THEN
    UPDATE public.exchanges
    SET status = 'planned',
        cancelled_at = NULL,
        cancellation_idempotency_key = NULL
    WHERE id = v_exchange.id;

    IF v_reception.id IS NOT NULL AND v_reception.status = 'cancelled' THEN
      UPDATE public.receptions
      SET status = 'awaiting_delivery'
      WHERE id = v_reception.id;

      INSERT INTO public.reception_status_history
        (reception_id, previous_status, new_status, changed_by, reason)
      VALUES
        (v_reception.id, 'cancelled', 'awaiting_delivery', p_actor_user_id, v_reason);
      INSERT INTO public.state_history
        (entity_type, entity_id, previous_state, new_state, changed_by, reason)
      VALUES
        ('reception', v_reception.id, 'cancelled', 'awaiting_delivery', p_actor_user_id, v_reason);
    END IF;

    IF v_request.status <> 'scheduled' THEN
      INSERT INTO public.request_status_history
        (request_id, previous_status, new_status, changed_by, reason)
      VALUES
        (v_request.id, v_request.status, 'scheduled', p_actor_user_id, v_reason);
      INSERT INTO public.state_history
        (entity_type, entity_id, previous_state, new_state, changed_by, reason)
      VALUES
        ('exchange_request', v_request.id, v_request.status, 'scheduled', p_actor_user_id, v_reason);
    END IF;

    UPDATE public.exchange_requests
    SET status = 'scheduled'
    WHERE id = v_request.id;

    v_new_status := 'committed';
  ELSE
    IF v_request.status <> 'under_review' THEN
      INSERT INTO public.request_status_history
        (request_id, previous_status, new_status, changed_by, reason)
      VALUES
        (v_request.id, v_request.status, 'under_review', p_actor_user_id, v_reason);
      INSERT INTO public.state_history
        (entity_type, entity_id, previous_state, new_state, changed_by, reason)
      VALUES
        ('exchange_request', v_request.id, v_request.status, 'under_review', p_actor_user_id, v_reason);
    END IF;

    UPDATE public.exchange_requests
    SET status = 'under_review'
    WHERE id = v_request.id;

    v_new_status := 'reserved';
  END IF;

  UPDATE public.loans
  SET status = v_new_status,
      closed_at = NULL,
      closed_by = NULL,
      closed_reason = NULL,
      reactivation_key = p_idempotency_key,
      reactivated_at = clock_timestamp(),
      reactivated_by = p_actor_user_id,
      reactivation_reason = v_reason,
      due_at = v_reservation.expires_at,
      updated_at = clock_timestamp()
  WHERE id = v_loan.id;

  INSERT INTO public.loan_events
    (loan_id, previous_status, new_status, actor_user_id, actor_kind, reason)
  VALUES
    (v_loan.id, 'cancelled', v_new_status, p_actor_user_id, 'administrator', v_reason);

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id,
     'loan.reactivated',
     'loan',
     v_loan.id::TEXT,
     jsonb_build_object(
       'request_id', v_request.id,
       'copy_id', v_copy.id,
       'reason', v_reason,
       'idempotency_key', p_idempotency_key
     ));

  SELECT * INTO v_loan FROM public.loans l WHERE l.id = v_loan.id;
  loan_id := v_loan.id;
  status := v_loan.status;
  request_id := v_loan.request_id;
  reservation_id := v_loan.reservation_id;
  copy_id := v_loan.copy_id;
  due_at := v_loan.due_at;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.reactivate_cancelled_loan(BIGINT, TEXT, UUID, BIGINT)
  FROM PUBLIC, iub_public_runtime;
GRANT EXECUTE ON FUNCTION public.reactivate_cancelled_loan(BIGINT, TEXT, UUID, BIGINT)
  TO iub_admin_runtime;
