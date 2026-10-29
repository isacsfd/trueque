-- 0013: preserve the login name when a legacy ADMIN_USERS account changes
-- its password or receives a reset. Additive and idempotent.
BEGIN;

CREATE OR REPLACE FUNCTION public.admin_change_own_password_named(
  p_actor_user_id BIGINT,
  p_password_hash TEXT,
  p_login_name TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_login TEXT := lower(btrim(coalesce(p_login_name, '')));
BEGIN
  IF p_password_hash IS NULL OR p_password_hash !~ '^scrypt\$[0-9a-f]+\$[0-9a-f]+$' THEN
    RAISE EXCEPTION 'invalid password hash' USING ERRCODE = '23514';
  END IF;
  IF length(v_login) < 3 OR length(v_login) > 200 THEN
    RAISE EXCEPTION 'invalid login name' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.admin_credentials
    (user_id, login_name, password_hash, must_change_password, session_version, password_changed_at)
  VALUES
    (p_actor_user_id, v_login, p_password_hash, FALSE, 1, now())
  ON CONFLICT (user_id) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        must_change_password = FALSE,
        session_version = public.admin_credentials.session_version + 1,
        password_changed_at = now(),
        updated_at = now();
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES (p_actor_user_id, 'account.password_changed', 'app_user', p_actor_user_id::TEXT,
          jsonb_build_object('sessions_revoked', TRUE));
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_reset_user_password_named(
  p_actor_user_id BIGINT,
  p_user_id BIGINT,
  p_password_hash TEXT,
  p_login_name TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_login TEXT := lower(btrim(coalesce(p_login_name, '')));
BEGIN
  IF NOT public.admin_has_account_manage(p_actor_user_id) THEN
    RAISE EXCEPTION 'the actor lacks account.manage' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = p_actor_user_id THEN
    RAISE EXCEPTION 'use the self password change flow' USING ERRCODE = '23514';
  END IF;
  IF p_password_hash IS NULL OR p_password_hash !~ '^scrypt\$[0-9a-f]+\$[0-9a-f]+$' THEN
    RAISE EXCEPTION 'invalid password hash' USING ERRCODE = '23514';
  END IF;
  UPDATE public.admin_credentials
  SET password_hash = p_password_hash,
      must_change_password = TRUE,
      session_version = session_version + 1,
      password_changed_at = now(),
      updated_at = now()
  WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    IF length(v_login) < 3 OR length(v_login) > 200 THEN
      RAISE EXCEPTION 'invalid login name' USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.admin_credentials
      (user_id, login_name, password_hash, must_change_password, session_version, password_changed_at)
    VALUES
      (p_user_id, v_login, p_password_hash, TRUE, 1, now());
  END IF;
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES (p_actor_user_id, 'account.password_reset', 'app_user', p_user_id::TEXT,
          jsonb_build_object('must_change_password', TRUE));
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_change_own_password_named(BIGINT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reset_user_password_named(BIGINT, BIGINT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_change_own_password_named(BIGINT, TEXT, TEXT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.admin_reset_user_password_named(BIGINT, BIGINT, TEXT, TEXT) TO iub_admin_runtime;

COMMIT;
