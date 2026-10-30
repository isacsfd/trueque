-- Nineteenth versioned migration. Public status lookup with a single opaque
-- token. The existing request access token (32 random bytes, stored as a
-- SHA-256 hash) is the primary lookup credential. Recovery tokens are stored
-- hashed in request_lookup_tokens and can be revoked independently of the
-- reservation access token.
--
-- This migration is additive and does not alter existing requests or codes.

CREATE UNIQUE INDEX IF NOT EXISTS exchange_requests_access_token_uidx
  ON public.exchange_requests (request_access_token_sha256)
  WHERE request_access_token_sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.request_lookup_tokens (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id BIGINT NOT NULL REFERENCES public.exchange_requests(id),
  token_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_by BIGINT NOT NULL REFERENCES public.app_users(id),
  revoked_at TIMESTAMPTZ,
  revoked_by BIGINT REFERENCES public.app_users(id),
  label TEXT CHECK (label IS NULL OR length(label) <= 120),
  CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS request_lookup_tokens_request_idx
  ON public.request_lookup_tokens (request_id, revoked_at);

CREATE TABLE IF NOT EXISTS public.public_status_rate_limits (
  bucket_key BYTEA PRIMARY KEY CHECK (octet_length(bucket_key) = 32),
  window_started_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0)
);

CREATE INDEX IF NOT EXISTS public_status_rate_limits_window_idx
  ON public.public_status_rate_limits (window_started_at);

CREATE OR REPLACE FUNCTION public.consume_public_status_rate_limit(
  p_bucket_key BYTEA,
  p_limit INTEGER,
  p_window_seconds INTEGER
)
RETURNS TABLE (allowed BOOLEAN, retry_after_seconds INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_attempts INTEGER;
  v_started TIMESTAMPTZ;
BEGIN
  IF octet_length(p_bucket_key) <> 32 THEN
    RAISE EXCEPTION 'invalid rate-limit bucket' USING ERRCODE = '22023';
  END IF;
  IF p_limit <= 0 OR p_window_seconds <= 0 THEN
    RAISE EXCEPTION 'invalid rate-limit configuration' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.public_status_rate_limits
  WHERE bucket_key IN (
    SELECT bucket_key
    FROM public.public_status_rate_limits
    WHERE window_started_at < clock_timestamp() - interval '2 hours'
    LIMIT 100
  );

  INSERT INTO public.public_status_rate_limits AS b
    (bucket_key, window_started_at, attempts)
  VALUES
    (p_bucket_key, clock_timestamp(), 1)
  ON CONFLICT (bucket_key) DO UPDATE
    SET attempts = CASE
          WHEN b.window_started_at <= clock_timestamp() - (p_window_seconds * interval '1 second')
            THEN 1
          ELSE b.attempts + 1
        END,
        window_started_at = CASE
          WHEN b.window_started_at <= clock_timestamp() - (p_window_seconds * interval '1 second')
            THEN clock_timestamp()
          ELSE b.window_started_at
        END
  RETURNING b.attempts, b.window_started_at
    INTO v_attempts, v_started;

  allowed := v_attempts <= p_limit;
  retry_after_seconds := CASE
    WHEN allowed THEN 0
    ELSE GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (
        v_started + (p_window_seconds * interval '1 second') - clock_timestamp()
      )))::INTEGER
    )
  END;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_public_request_status_by_token(
  p_access_hash BYTEA
)
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
  WHERE p_access_hash IS NOT NULL
    AND (
      r.request_access_token_sha256 = p_access_hash
      OR EXISTS (
        SELECT 1
        FROM public.request_lookup_tokens t
        WHERE t.request_id = r.id
          AND t.token_hash = p_access_hash
          AND t.revoked_at IS NULL
      )
    )
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.issue_request_lookup_token(
  p_request_id BIGINT,
  p_token_hash BYTEA,
  p_actor_user_id BIGINT,
  p_label TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_id BIGINT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'requests.review');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  IF octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION 'invalid lookup token hash' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.exchange_requests WHERE id = p_request_id) THEN
    RAISE EXCEPTION 'request not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.request_lookup_tokens
    (request_id, token_hash, created_by, label)
  VALUES
    (p_request_id, p_token_hash, p_actor_user_id, p_label)
  RETURNING id INTO v_id;

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'request.lookup_token_issued', 'exchange_request', p_request_id::TEXT,
     jsonb_build_object('token_id', v_id, 'label', p_label));

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_request_lookup_token(
  p_token_id BIGINT,
  p_actor_user_id BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request_id BIGINT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'requests.review');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  UPDATE public.request_lookup_tokens
  SET revoked_at = clock_timestamp(), revoked_by = p_actor_user_id
  WHERE id = p_token_id AND revoked_at IS NULL
  RETURNING request_id INTO v_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active lookup token not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'request.lookup_token_revoked', 'exchange_request', v_request_id::TEXT,
     jsonb_build_object('token_id', p_token_id));

  RETURN;
END;
$function$;

REVOKE ALL ON TABLE public.request_lookup_tokens, public.public_status_rate_limits
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;

REVOKE ALL ON FUNCTION public.consume_public_status_rate_limit(BYTEA, INTEGER, INTEGER)
  FROM PUBLIC, iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.consume_public_status_rate_limit(BYTEA, INTEGER, INTEGER)
  TO iub_public_runtime;

REVOKE ALL ON FUNCTION public.get_public_request_status_by_token(BYTEA)
  FROM PUBLIC, iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.get_public_request_status_by_token(BYTEA)
  TO iub_public_runtime;

REVOKE ALL ON FUNCTION public.issue_request_lookup_token(BIGINT, BYTEA, BIGINT, TEXT)
  FROM PUBLIC, iub_public_runtime;
GRANT EXECUTE ON FUNCTION public.issue_request_lookup_token(BIGINT, BYTEA, BIGINT, TEXT)
  TO iub_admin_runtime;

REVOKE ALL ON FUNCTION public.revoke_request_lookup_token(BIGINT, BIGINT)
  FROM PUBLIC, iub_public_runtime;
GRANT EXECUTE ON FUNCTION public.revoke_request_lookup_token(BIGINT, BIGINT)
  TO iub_admin_runtime;
