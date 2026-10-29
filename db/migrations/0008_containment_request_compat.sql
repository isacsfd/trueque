-- Eighth versioned migration. Refines the 0007 request guard to preserve the
-- pre-existing behaviour that a request may reference a currently unavailable
-- copy (the reservation gate still rejects it). The P0 containment remains:
-- an unverified institutional copy can never be the target of a new request.
--
-- This migration does not change availability, verification, movements or audit.

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

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_institutional_request_copy()
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;

-- The trigger created by 0007 invokes this function by name; no trigger change
-- is needed. reserve_copy remains the gate for availability and commitment.
