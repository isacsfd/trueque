-- 0024_loans.sql
--
-- Historial auditable de préstamos/trueques en curso y cerrados, y vigencia
-- mínima de 48 horas para las reservas activas.
--
-- La migración es aditiva: no borra ni reescribe historiales, no cambia las
-- rutinas transaccionales existentes y solo añade registros/guardas que se
-- ejecutan dentro de la misma transacción de reserva, aprobación, entrega,
-- cierre, cancelación o expiración.

DO $precondition$
BEGIN
  IF to_regclass('public.reservations') IS NULL
     OR to_regclass('public.exchange_requests') IS NULL
     OR to_regclass('public.exchanges') IS NULL
     OR to_regclass('public.deliveries') IS NULL
     OR to_regclass('public.reservation_policy') IS NULL
     OR to_regprocedure('public.set_reservation_policy(integer,bigint)') IS NULL THEN
    RAISE EXCEPTION '0024 requires the reservations, exchanges and policy baseline'
      USING ERRCODE = '55000';
  END IF;
END
$precondition$;

-- ---------------------------------------------------------------------------
-- 1. Vigencia mínima de 48 horas
-- ---------------------------------------------------------------------------

ALTER TABLE public.reservation_policy
  ADD CONSTRAINT reservation_policy_min_duration_ck
  CHECK (duration_seconds >= 172800) NOT VALID;

UPDATE public.reservation_policy
SET duration_seconds = 172800
WHERE duration_seconds < 172800;

ALTER TABLE public.reservation_policy
  VALIDATE CONSTRAINT reservation_policy_min_duration_ck;

-- Las reservas activas ya creadas con una vigencia menor se ajustan a la
-- vigencia mínima desde su creación.
UPDATE public.reservations
SET expires_at = created_at + interval '48 hours'
WHERE status = 'active'
  AND expires_at < created_at + interval '48 hours';

CREATE OR REPLACE FUNCTION public.set_reservation_policy(
  p_duration_seconds INTEGER,
  p_actor_user_id BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'reservations.configure');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  IF p_duration_seconds IS NULL OR p_duration_seconds < 172800 THEN
    RAISE EXCEPTION 'the reservation duration must be at least 48 hours'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.reservation_policy (policy_id, duration_seconds, updated_by, updated_at)
  VALUES (1, p_duration_seconds, p_actor_user_id, clock_timestamp())
  ON CONFLICT (policy_id) DO UPDATE
    SET duration_seconds = EXCLUDED.duration_seconds,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'reservation_policy.updated', 'reservation_policy', '1',
     jsonb_build_object('duration_seconds', p_duration_seconds));
END;
$function$;

REVOKE ALL ON FUNCTION public.set_reservation_policy(INTEGER, BIGINT)
  FROM PUBLIC, iub_public_runtime;
GRANT EXECUTE ON FUNCTION public.set_reservation_policy(INTEGER, BIGINT)
  TO iub_admin_runtime;

-- ---------------------------------------------------------------------------
-- 2. Historial de préstamos
-- ---------------------------------------------------------------------------

CREATE TABLE public.loans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id BIGINT NOT NULL REFERENCES public.exchange_requests(id),
  reservation_id BIGINT NOT NULL UNIQUE REFERENCES public.reservations(id),
  exchange_id BIGINT REFERENCES public.exchanges(id),
  copy_id BIGINT NOT NULL REFERENCES public.copies(id),
  returned_copy_id BIGINT REFERENCES public.copies(id),
  status TEXT NOT NULL CHECK (status IN (
    'reserved', 'committed', 'lent', 'return_pending', 'completed', 'cancelled', 'expired'
  )),
  started_at TIMESTAMPTZ NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  closed_by BIGINT REFERENCES public.app_users(id),
  closed_reason TEXT,
  dropoff_delivery_id BIGINT REFERENCES public.deliveries(id),
  handover_delivery_id BIGINT REFERENCES public.deliveries(id),
  return_delivery_id BIGINT REFERENCES public.deliveries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (closed_at IS NOT NULL OR status NOT IN ('completed', 'cancelled', 'expired')),
  CHECK (closed_at IS NULL OR status IN ('completed', 'cancelled', 'expired')),
  CHECK (closed_at IS NULL OR closed_reason IS NOT NULL),
  CHECK (returned_copy_id IS NULL OR returned_copy_id <> copy_id)
);

CREATE INDEX loans_status_started_idx
  ON public.loans (status, started_at DESC);
CREATE INDEX loans_request_idx
  ON public.loans (request_id);
CREATE INDEX loans_copy_idx
  ON public.loans (copy_id);
CREATE UNIQUE INDEX loans_exchange_uidx
  ON public.loans (exchange_id)
  WHERE exchange_id IS NOT NULL;

COMMENT ON TABLE public.loans IS
  'Historial auditable de préstamos/trueques; las filas cerradas no se reescriben ni se eliminan.';

CREATE TABLE public.loan_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  loan_id BIGINT NOT NULL REFERENCES public.loans(id),
  previous_status TEXT,
  new_status TEXT NOT NULL,
  actor_user_id BIGINT REFERENCES public.app_users(id),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('participant', 'administrator', 'system')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX loan_events_loan_created_idx
  ON public.loan_events (loan_id, created_at DESC, id DESC);

COMMENT ON TABLE public.loan_events IS
  'Transiciones append-only del préstamo con actor autorizado o participante token-holder.';

REVOKE ALL ON public.loans, public.loan_events
  FROM PUBLIC, iub_public_runtime;
GRANT SELECT ON public.loans, public.loan_events
  TO iub_admin_runtime;

-- ---------------------------------------------------------------------------
-- 3. Transiciones desde reservas, intercambios y entregas
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.loan_actor()
RETURNS TABLE (actor_user_id BIGINT, actor_kind TEXT)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_setting TEXT;
  v_actor BIGINT;
BEGIN
  v_setting := coalesce(nullif(current_setting('app.actor_user_id', TRUE), ''), '0');
  v_actor := nullif(v_setting::BIGINT, 0);
  actor_user_id := v_actor;
  actor_kind := CASE
    WHEN v_actor IS NOT NULL THEN 'administrator'
    ELSE 'participant'
  END;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_loan_from_reservation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_loan public.loans%ROWTYPE;
  v_actor BIGINT;
  v_actor_kind TEXT;
  v_new_status TEXT;
  v_reason TEXT;
BEGIN
  SELECT actor_user_id, actor_kind
  INTO v_actor, v_actor_kind
  FROM public.loan_actor();

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.loans
      (request_id, reservation_id, copy_id, status, started_at, due_at)
    VALUES
      (NEW.request_id, NEW.id, NEW.copy_id,
       CASE WHEN NEW.status = 'converted' THEN 'committed' ELSE 'reserved' END,
       NEW.created_at, NEW.expires_at)
    RETURNING * INTO v_loan;

    INSERT INTO public.loan_events
      (loan_id, previous_status, new_status, actor_user_id, actor_kind, reason)
    VALUES
      (v_loan.id, NULL, v_loan.status, v_actor, v_actor_kind,
       CASE WHEN v_actor IS NULL THEN 'Reserva creada por participante' ELSE 'Reserva creada' END);
    RETURN NEW;
  END IF;

  SELECT * INTO v_loan
  FROM public.loans l
  WHERE l.reservation_id = NEW.id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_loan.status NOT IN ('completed', 'cancelled', 'expired')
     AND NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    UPDATE public.loans
    SET due_at = NEW.expires_at, updated_at = clock_timestamp()
    WHERE id = v_loan.id;
  END IF;

  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  v_reason := CASE
    WHEN NEW.status = 'converted' THEN 'Solicitud aprobada; reserva comprometida'
    WHEN NEW.status = 'expired' THEN 'Reserva vencida'
    WHEN NEW.status = 'released' THEN 'Reserva liberada por cierre o cancelación'
    ELSE 'Transición de reserva'
  END;

  v_new_status := CASE
    WHEN NEW.status = 'converted' THEN 'committed'
    WHEN NEW.status = 'expired' THEN 'expired'
    WHEN NEW.status = 'released' THEN 'cancelled'
    ELSE v_loan.status
  END;

  IF v_new_status IN ('completed', 'cancelled', 'expired') THEN
    UPDATE public.loans
    SET status = v_new_status,
        closed_at = coalesce(NEW.released_at, clock_timestamp()),
        closed_by = v_actor,
        closed_reason = v_reason,
        updated_at = clock_timestamp()
    WHERE id = v_loan.id
      AND status NOT IN ('completed', 'cancelled', 'expired');
  ELSIF v_loan.status NOT IN ('completed', 'cancelled', 'expired') THEN
    UPDATE public.loans
    SET status = v_new_status, updated_at = clock_timestamp()
    WHERE id = v_loan.id;
  END IF;

  SELECT * INTO v_loan FROM public.loans l WHERE l.id = v_loan.id;
  INSERT INTO public.loan_events
    (loan_id, previous_status, new_status, actor_user_id, actor_kind, reason)
  VALUES
    (v_loan.id, OLD.status::TEXT, v_new_status, v_actor, v_actor_kind, v_reason);

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS loans_reservation_sync_trigger ON public.reservations;
CREATE TRIGGER loans_reservation_sync_trigger
  AFTER INSERT OR UPDATE OF status, expires_at ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.sync_loan_from_reservation();

CREATE OR REPLACE FUNCTION public.sync_loan_from_exchange()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_loan public.loans%ROWTYPE;
  v_copy public.copies%ROWTYPE;
  v_actor BIGINT;
  v_actor_kind TEXT;
  v_new_status TEXT;
  v_reason TEXT;
BEGIN
  SELECT actor_user_id, actor_kind
  INTO v_actor, v_actor_kind
  FROM public.loan_actor();

  IF TG_OP = 'INSERT' THEN
    UPDATE public.loans
    SET exchange_id = NEW.id, updated_at = clock_timestamp()
    WHERE request_id = NEW.request_id
      AND exchange_id IS NULL
      AND status NOT IN ('completed', 'cancelled', 'expired');
    RETURN NEW;
  END IF;

  SELECT * INTO v_loan
  FROM public.loans l
  WHERE l.request_id = NEW.request_id
    AND (l.exchange_id = NEW.id OR l.exchange_id IS NULL)
  ORDER BY l.started_at DESC, l.id DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_loan.exchange_id IS NULL THEN
    UPDATE public.loans
    SET exchange_id = NEW.id, updated_at = clock_timestamp()
    WHERE id = v_loan.id;
  END IF;

  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'in_process' THEN
    v_new_status := 'lent';
    v_reason := 'Préstamo iniciado';
  ELSIF NEW.status = 'cancellation_pending' THEN
    v_new_status := 'return_pending';
    v_reason := 'Devolución o cancelación pendiente';
  ELSIF NEW.status = 'completed' THEN
    v_new_status := 'completed';
    v_reason := 'Trueque completado con entregas confirmadas';
  ELSIF NEW.status = 'cancelled' THEN
    v_new_status := 'cancelled';
    v_reason := 'Préstamo cancelado con compensación válida';
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.status = 'completed' THEN
    SELECT * INTO v_copy FROM public.copies c WHERE c.id = NEW.offered_copy_id FOR UPDATE;
    IF NOT FOUND OR v_copy.availability <> 'available' THEN
      RAISE EXCEPTION 'the completed loan requires its returned copy available'
        USING ERRCODE = '23514';
    END IF;

    UPDATE public.loans
    SET status = v_new_status,
        returned_copy_id = NEW.offered_copy_id,
        closed_at = coalesce(NEW.completed_at, clock_timestamp()),
        closed_by = v_actor,
        closed_reason = v_reason,
        updated_at = clock_timestamp()
    WHERE id = v_loan.id
      AND status NOT IN ('completed', 'cancelled', 'expired');
  ELSIF NEW.status = 'cancelled' THEN
    SELECT * INTO v_copy FROM public.copies c WHERE c.id = NEW.institutional_copy_id FOR UPDATE;
    IF NOT FOUND OR v_copy.availability <> 'available' THEN
      RAISE EXCEPTION 'the cancelled loan requires the institutional copy available'
        USING ERRCODE = '23514';
    END IF;

    UPDATE public.loans
    SET status = v_new_status,
        closed_at = clock_timestamp(),
        closed_by = v_actor,
        closed_reason = v_reason,
        updated_at = clock_timestamp()
    WHERE id = v_loan.id
      AND status NOT IN ('completed', 'cancelled', 'expired');
  ELSE
    UPDATE public.loans
    SET status = v_new_status, updated_at = clock_timestamp()
    WHERE id = v_loan.id
      AND status NOT IN ('completed', 'cancelled', 'expired');
  END IF;

  SELECT * INTO v_loan FROM public.loans l WHERE l.id = v_loan.id;
  INSERT INTO public.loan_events
    (loan_id, previous_status, new_status, actor_user_id, actor_kind, reason)
  VALUES
    (v_loan.id, OLD.status::TEXT, v_new_status, v_actor, v_actor_kind, v_reason);

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS loans_exchange_sync_trigger ON public.exchanges;
CREATE TRIGGER loans_exchange_sync_trigger
  AFTER INSERT OR UPDATE OF status ON public.exchanges
  FOR EACH ROW EXECUTE FUNCTION public.sync_loan_from_exchange();

CREATE OR REPLACE FUNCTION public.sync_loan_deliveries()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_field TEXT;
BEGIN
  v_field := CASE NEW.delivery_type
    WHEN 'offered_book_dropoff' THEN 'dropoff_delivery_id'
    WHEN 'institutional_copy_handover' THEN 'handover_delivery_id'
    WHEN 'offered_book_return' THEN 'return_delivery_id'
    ELSE NULL
  END;

  IF v_field IS NULL THEN
    RETURN NEW;
  END IF;

  EXECUTE format(
    'UPDATE public.loans l
     SET %I = $1, updated_at = clock_timestamp()
     WHERE l.request_id = $2
       AND l.status NOT IN (''completed'', ''cancelled'', ''expired'')',
    v_field
  )
  USING NEW.id, NEW.request_id;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS loans_delivery_sync_trigger ON public.deliveries;
CREATE TRIGGER loans_delivery_sync_trigger
  AFTER INSERT OR UPDATE OF status ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public.sync_loan_deliveries();

-- ---------------------------------------------------------------------------
-- 4. Backfill preservando los préstamos ya existentes
-- ---------------------------------------------------------------------------

INSERT INTO public.loans
  (request_id, reservation_id, exchange_id, copy_id, status,
   started_at, due_at, closed_at, closed_by, closed_reason)
SELECT
  r.request_id,
  r.id,
  e.id,
  r.copy_id,
  CASE
    WHEN r.status = 'active' THEN 'reserved'
    WHEN r.status = 'converted' AND e.status = 'in_process' THEN 'lent'
    WHEN r.status = 'converted' THEN 'committed'
    WHEN r.status = 'expired' THEN 'expired'
    WHEN r.status = 'released' THEN 'cancelled'
  END,
  r.created_at,
  r.expires_at,
  CASE WHEN r.status IN ('expired', 'released') THEN r.released_at END,
  latest.changed_by,
  CASE
    WHEN r.status = 'expired' THEN 'Reserva vencida'
    WHEN r.status = 'released' THEN 'Reserva liberada por cierre o cancelación'
  END
FROM public.reservations r
LEFT JOIN public.exchanges e ON e.request_id = r.request_id
LEFT JOIN LATERAL (
  SELECT h.changed_by
  FROM public.request_status_history h
  WHERE h.request_id = r.request_id
  ORDER BY h.id DESC
  LIMIT 1
) latest ON TRUE
ON CONFLICT (reservation_id) DO NOTHING;

UPDATE public.loans l
SET dropoff_delivery_id = d.id
FROM public.deliveries d
WHERE d.request_id = l.request_id
  AND d.delivery_type = 'offered_book_dropoff'
  AND l.dropoff_delivery_id IS NULL;

UPDATE public.loans l
SET handover_delivery_id = d.id
FROM public.deliveries d
WHERE d.request_id = l.request_id
  AND d.delivery_type = 'institutional_copy_handover'
  AND l.handover_delivery_id IS NULL;

UPDATE public.loans l
SET return_delivery_id = d.id
FROM public.deliveries d
WHERE d.request_id = l.request_id
  AND d.delivery_type = 'offered_book_return'
  AND l.return_delivery_id IS NULL;

INSERT INTO public.loan_events
  (loan_id, previous_status, new_status, actor_user_id, actor_kind, reason)
SELECT
  l.id,
  NULL,
  l.status,
  l.closed_by,
  CASE WHEN l.closed_by IS NULL THEN 'system' ELSE 'administrator' END,
  coalesce(l.closed_reason, 'Préstamo registrado en la migración inicial del historial')
FROM public.loans l
WHERE NOT EXISTS (SELECT 1 FROM public.loan_events le WHERE le.loan_id = l.id);
