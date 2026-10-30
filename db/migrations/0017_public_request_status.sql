-- Seventeenth versioned migration. Public, read-only request status lookup by
-- request code. The request code is the public credential; this routine never
-- returns participant contact data, internal reasons, notes or audit data.

CREATE OR REPLACE FUNCTION public.get_public_request_status(p_request_code TEXT)
RETURNS TABLE (
  request_code TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  offered_title TEXT,
  offered_author TEXT,
  requested_title TEXT,
  requested_author TEXT,
  requested_inventory_code TEXT,
  reservation_status TEXT,
  reservation_expires_at TIMESTAMPTZ,
  exchange_status TEXT,
  exchange_completed_at TIMESTAMPTZ,
  reception_status TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    r.request_code,
    r.status,
    r.created_at,
    ob.title AS offered_title,
    ob.author AS offered_author,
    b.title AS requested_title,
    b.author AS requested_author,
    c.inventory_code AS requested_inventory_code,
    res.status AS reservation_status,
    res.expires_at AS reservation_expires_at,
    e.status AS exchange_status,
    e.completed_at AS exchange_completed_at,
    rec.status AS reception_status
  FROM public.exchange_requests r
  LEFT JOIN public.offered_books ob ON ob.request_id = r.id
  LEFT JOIN public.copies c ON c.id = r.requested_copy_id
  LEFT JOIN public.bibliographic_records b ON b.id = c.bibliographic_record_id
  LEFT JOIN LATERAL (
    SELECT rv.status, rv.expires_at
    FROM public.reservations rv
    WHERE rv.request_id = r.id AND rv.copy_id = r.requested_copy_id
    ORDER BY rv.id DESC
    LIMIT 1
  ) res ON TRUE
  LEFT JOIN public.exchanges e ON e.request_id = r.id
  LEFT JOIN public.receptions rec ON rec.id = e.offered_reception_id
  WHERE r.request_code = upper(btrim(p_request_code))
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.get_public_request_status(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_request_status(TEXT) TO iub_public_runtime;
