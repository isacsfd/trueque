-- 0026_migration_chain_compat.sql
--
-- Puente aditivo para la cadena canónica completa.
--
-- 0011 añadió un guard que exigía una reserva `active` en el momento de
-- aprobar. 0016 convierte esa reserva a `converted` antes de actualizar la
-- solicitud, por lo que la misma aprobación válida fallaba. Esta migración
-- reemplaza el guard aceptando exactamente el compromiso creado por 0016 para
-- la misma solicitud y ejemplar, sin relajar los bloqueos de copias no
-- disponibles, no verificadas ni comprometidas a otra solicitud.
--
-- No modifica migraciones previas, no cambia datos ni disponibilidad y no
-- elimina historiales.

DO $precondition$
BEGIN
  IF to_regclass('public.exchange_requests') IS NULL
     OR to_regclass('public.copies') IS NULL
     OR to_regclass('public.reservations') IS NULL
     OR to_regprocedure('public.assert_actor_permission(bigint,text)') IS NULL THEN
    RAISE EXCEPTION '0026 requires the request, copy and reservation baseline'
      USING ERRCODE = '55000';
  END IF;
END
$precondition$;

CREATE OR REPLACE FUNCTION public.guard_request_copy_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_copy public.copies%ROWTYPE;
  v_has_valid_reservation BOOLEAN;
BEGIN
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM NEW.status THEN
    SELECT * INTO v_copy
    FROM public.copies
    WHERE id = NEW.requested_copy_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'the requested copy does not exist' USING ERRCODE = 'P0002';
    END IF;

    IF v_copy.availability NOT IN ('available', 'reserved') THEN
      RAISE EXCEPTION 'the requested copy is not available for approval'
        USING ERRCODE = '23514';
    END IF;

    IF v_copy.availability = 'reserved' THEN
      SELECT EXISTS (
        SELECT 1 FROM public.reservations r
        WHERE r.request_id = NEW.id
          AND r.copy_id = NEW.requested_copy_id
          AND (
            (
              r.status = 'active'
              AND r.expires_at > clock_timestamp()
            )
            OR (
              r.status = 'converted'
              AND r.released_at IS NOT NULL
            )
          )
      ) INTO v_has_valid_reservation;

      IF NOT v_has_valid_reservation THEN
        RAISE EXCEPTION 'the requested copy has no valid active or committed reservation'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF v_copy.provenance_type = 'institutional'
       AND (v_copy.verified_at IS NULL OR v_copy.physical_condition = 'unassessed') THEN
      RAISE EXCEPTION 'an unverified institutional copy cannot be approved'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS exchange_requests_copy_approval_guard
  ON public.exchange_requests;
CREATE TRIGGER exchange_requests_copy_approval_guard
  BEFORE UPDATE OF status ON public.exchange_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_request_copy_approval();

REVOKE ALL ON FUNCTION public.guard_request_copy_approval()
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;

-- En la cadena 0016+, el rechazo físico del libro ofrecido cancela el
-- intercambio con la reserva ya convertida. Antes de que el guard de
-- préstamos valide el cierre, liberar el compromiso institucional y restaurar
-- su disponibilidad dentro de la misma transacción.
CREATE OR REPLACE FUNCTION public.release_loan_reservation_before_exchange_close()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_reservation_id BIGINT;
  v_actor_setting TEXT;
  v_actor BIGINT;
BEGIN
  IF NEW.status <> 'cancelled' OR OLD.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  v_actor_setting := coalesce(nullif(current_setting('app.actor_user_id', TRUE), ''), '0');
  v_actor := nullif(v_actor_setting::BIGINT, 0);

  SELECT r.id INTO v_reservation_id
  FROM public.reservations r
  WHERE r.request_id = NEW.request_id
    AND r.copy_id = NEW.institutional_copy_id
    AND r.status IN ('active', 'converted')
  ORDER BY r.id DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    PERFORM public.release_reservation_hold(
      v_reservation_id,
      v_actor,
      'exchange closed by accepted physical rejection'
    );
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS aaa_release_loan_reservation_before_exchange_close
  ON public.exchanges;
CREATE TRIGGER aaa_release_loan_reservation_before_exchange_close
  BEFORE UPDATE OF status ON public.exchanges
  FOR EACH ROW EXECUTE FUNCTION public.release_loan_reservation_before_exchange_close();

REVOKE ALL ON FUNCTION public.release_loan_reservation_before_exchange_close()
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;

-- 0012 otorgó INSERT/UPDATE directos a admin_credentials para sus rutinas.
-- Las rutinas son SECURITY DEFINER y no necesitan DML directo; mantenerlo
-- rompe la política del runner. Este puente devuelve esa tabla a acceso
-- exclusivo por funciones.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.admin_credentials
  FROM iub_admin_runtime;
