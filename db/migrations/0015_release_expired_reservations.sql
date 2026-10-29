-- Fifteenth versioned migration. Expired reservations must not keep copies
-- out of the public catalogue forever. This wrapper is safe to call from the
-- public catalogue: it only releases reservations whose expires_at has passed.
--
-- expire_reservations still performs its own permission check. The primary
-- SUPER ADMIN actor (user 3) is used as the gate for this system operation.
-- The wrapper does not read credentials and exposes only the expiry operation.

CREATE OR REPLACE FUNCTION public.release_expired_reservations()
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.expire_reservations(3, 100);
$function$;

REVOKE ALL ON FUNCTION public.release_expired_reservations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_expired_reservations() TO iub_public_runtime;
