-- Eighteenth versioned migration. Planning an exchange no longer requires a
-- manually entered receipt code. The historical column is kept for existing
-- receptions, but new receptions may leave it empty.
--
-- The initial offered-book dropoff is created atomically with the exchange so
-- the panel always has a proposed delivery date. The date is interpreted in
-- the institutional timezone (America/Bogota) when deciding whether physical
-- delivery can be confirmed.

ALTER TABLE public.receptions
  ALTER COLUMN receipt_code DROP NOT NULL;

COMMENT ON COLUMN public.receptions.receipt_code IS
  'Optional historical receipt code. New receptions are planned without a manually entered code.';

CREATE OR REPLACE FUNCTION public.plan_exchange_with_dropoff(
  p_request_id BIGINT,
  p_scheduled_at TIMESTAMPTZ,
  p_planning_key UUID,
  p_actor_user_id BIGINT
)
RETURNS TABLE (
  exchange_id BIGINT,
  reception_id BIGINT,
  delivery_id BIGINT,
  delivery_scheduled_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_exchange_id BIGINT;
  v_reception_id BIGINT;
  v_delivery_id BIGINT;
  v_scheduled_at TIMESTAMPTZ;
  v_exchange_status TEXT;
  v_reception_status TEXT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'exchange.plan');
  PERFORM public.assert_actor_permission(p_actor_user_id, 'delivery.schedule');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT p.exchange_id, p.reception_id
    INTO v_exchange_id, v_reception_id
  FROM public.plan_exchange(
    p_request_id,
    NULL,
    p_planning_key,
    p_actor_user_id
  ) AS p;

  -- Idempotent replay: reuse the already-created dropoff and keep its date.
  SELECT d.id, d.scheduled_at
    INTO v_delivery_id, v_scheduled_at
  FROM public.deliveries d
  WHERE d.exchange_id = v_exchange_id
    AND d.delivery_type = 'offered_book_dropoff'
    AND d.status IN ('scheduled', 'in_progress', 'completed')
  ORDER BY d.id DESC
  LIMIT 1;

  IF FOUND THEN
    exchange_id := v_exchange_id;
    reception_id := v_reception_id;
    delivery_id := v_delivery_id;
    delivery_scheduled_at := v_scheduled_at;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT e.status INTO v_exchange_status
  FROM public.exchanges e
  WHERE e.id = v_exchange_id;

  SELECT r.status INTO v_reception_status
  FROM public.receptions r
  WHERE r.id = v_reception_id;

  IF v_exchange_status <> 'planned' OR v_reception_status <> 'awaiting_delivery' THEN
    RAISE EXCEPTION 'the exchange is not awaiting a dropoff schedule'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.deliveries
    (request_id, reception_id, exchange_id, delivery_type, status, scheduled_at,
     recorded_by, idempotency_key)
  VALUES
    (p_request_id, v_reception_id, v_exchange_id, 'offered_book_dropoff',
     'scheduled', coalesce(p_scheduled_at, clock_timestamp()),
     p_actor_user_id, p_planning_key)
  RETURNING id, scheduled_at INTO v_delivery_id, v_scheduled_at;

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'delivery.scheduled', 'delivery', v_delivery_id::TEXT,
     jsonb_build_object(
       'exchange_id', v_exchange_id,
       'type', 'offered_book_dropoff',
       'scheduled_at', v_scheduled_at
     ));

  exchange_id := v_exchange_id;
  reception_id := v_reception_id;
  delivery_id := v_delivery_id;
  delivery_scheduled_at := v_scheduled_at;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.plan_exchange_with_dropoff(BIGINT, TIMESTAMPTZ, UUID, BIGINT)
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.plan_exchange_with_dropoff(BIGINT, TIMESTAMPTZ, UUID, BIGINT)
  TO iub_admin_runtime;

CREATE OR REPLACE FUNCTION public.enforce_dropoff_not_early()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.delivery_type = 'offered_book_dropoff'
     AND NEW.status = 'completed'
     AND OLD.status IN ('scheduled', 'in_progress')
     AND NEW.scheduled_at IS NOT NULL
     AND (NEW.scheduled_at AT TIME ZONE 'America/Bogota')::date
         > (clock_timestamp() AT TIME ZONE 'America/Bogota')::date THEN
    RAISE EXCEPTION 'the offered book cannot be confirmed before its scheduled date'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_dropoff_not_early()
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;

DROP TRIGGER IF EXISTS deliveries_dropoff_not_early ON public.deliveries;
CREATE TRIGGER deliveries_dropoff_not_early
  BEFORE UPDATE ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_dropoff_not_early();
