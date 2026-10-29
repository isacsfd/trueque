BEGIN;
-- 0012: single source of truth for administrative credentials.
-- Additive and idempotent. No historical migration is modified.
-- Existing ADMIN_USERS entries remain a fallback until their password is
-- changed or reset; the first change creates the database credential row.

CREATE TABLE IF NOT EXISTS public.admin_credentials (
  user_id BIGINT PRIMARY KEY,
  login_name TEXT NOT NULL UNIQUE CHECK (length(btrim(login_name)) BETWEEN 3 AND 200),
  password_hash TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version > 0),
  password_changed_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_credentials_login_idx
  ON public.admin_credentials (lower(login_name));

REVOKE ALL ON public.admin_credentials FROM PUBLIC, iub_public_runtime;
GRANT SELECT, INSERT, UPDATE ON public.admin_credentials TO iub_admin_runtime;
GRANT SELECT ON public.audit_events TO iub_admin_runtime;

CREATE OR REPLACE FUNCTION public.admin_has_account_manage(p_actor_user_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.app_users u
    JOIN public.user_roles ur ON ur.user_id = u.id
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE u.id = p_actor_user_id
      AND u.is_active
      AND p.permission_key = 'account.manage'
  );
$function$;

CREATE OR REPLACE FUNCTION public.admin_create_user(
  p_actor_user_id BIGINT,
  p_login_name TEXT,
  p_email TEXT,
  p_password_hash TEXT,
  p_role_key TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_user_id BIGINT;
  v_role_id BIGINT;
  v_login TEXT := lower(btrim(coalesce(p_login_name, '')));
  v_email TEXT := lower(btrim(coalesce(p_email, '')));
BEGIN
  IF NOT public.admin_has_account_manage(p_actor_user_id) THEN
    RAISE EXCEPTION 'the actor lacks account.manage' USING ERRCODE = '42501';
  END IF;
  IF length(v_login) < 3 OR length(v_login) > 200 THEN
    RAISE EXCEPTION 'invalid login name' USING ERRCODE = '23514';
  END IF;
  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'invalid email' USING ERRCODE = '23514';
  END IF;
  IF p_password_hash IS NULL OR p_password_hash !~ '^scrypt\$[0-9a-f]+\$[0-9a-f]+$' THEN
    RAISE EXCEPTION 'invalid password hash' USING ERRCODE = '23514';
  END IF;
  SELECT id INTO v_role_id FROM public.roles WHERE role_key = p_role_key;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'role not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.admin_credentials WHERE login_name = v_login)
     OR EXISTS (SELECT 1 FROM public.app_users WHERE lower(identity_subject) = v_login)
     OR EXISTS (SELECT 1 FROM public.app_users WHERE email_normalized = v_email) THEN
    RAISE EXCEPTION 'account already exists' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.app_users (identity_issuer, identity_subject, email, email_normalized, is_active)
  VALUES ('local', v_login, v_email, v_email, TRUE)
  RETURNING id INTO v_user_id;
  INSERT INTO public.admin_credentials (user_id, login_name, password_hash, must_change_password)
  VALUES (v_user_id, v_login, p_password_hash, TRUE);
  INSERT INTO public.user_roles (user_id, role_id, assigned_by)
  VALUES (v_user_id, v_role_id, p_actor_user_id);
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES (p_actor_user_id, 'account.created', 'app_user', v_user_id::TEXT,
          jsonb_build_object('login_name', v_login, 'role_key', p_role_key, 'must_change_password', TRUE));
  RETURN v_user_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_user_active(
  p_actor_user_id BIGINT,
  p_user_id BIGINT,
  p_active BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_is_super BOOLEAN;
  v_other_super INTEGER;
BEGIN
  IF NOT public.admin_has_account_manage(p_actor_user_id) THEN
    RAISE EXCEPTION 'the actor lacks account.manage' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = p_actor_user_id THEN
    RAISE EXCEPTION 'an account cannot change its own active state' USING ERRCODE = '42501';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = p_user_id AND r.role_key = 'super_admin'
  ) INTO v_is_super;
  IF v_is_super AND p_active = FALSE THEN
    SELECT count(*) INTO v_other_super
    FROM public.app_users u
    JOIN public.user_roles ur ON ur.user_id = u.id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE r.role_key = 'super_admin' AND u.is_active AND u.id <> p_user_id;
    IF v_other_super = 0 THEN
      RAISE EXCEPTION 'the last active super admin cannot be deactivated' USING ERRCODE = '23514';
    END IF;
  END IF;
  UPDATE public.app_users SET is_active = p_active, updated_at = now() WHERE id = p_user_id;
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES (p_actor_user_id, CASE WHEN p_active THEN 'account.activated' ELSE 'account.deactivated' END,
          'app_user', p_user_id::TEXT, jsonb_build_object('active', p_active));
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_assign_user_role(
  p_actor_user_id BIGINT,
  p_user_id BIGINT,
  p_role_key TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_role_id BIGINT;
BEGIN
  IF NOT public.admin_has_account_manage(p_actor_user_id) THEN
    RAISE EXCEPTION 'the actor lacks account.manage' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = p_actor_user_id THEN
    RAISE EXCEPTION 'an account cannot change its own roles' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO v_role_id FROM public.roles WHERE role_key = p_role_key;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'role not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.user_roles (user_id, role_id, assigned_by)
  VALUES (p_user_id, v_role_id, p_actor_user_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES (p_actor_user_id, 'account.role_assigned', 'app_user', p_user_id::TEXT,
          jsonb_build_object('role_key', p_role_key));
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_remove_user_role(
  p_actor_user_id BIGINT,
  p_user_id BIGINT,
  p_role_key TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_role_id BIGINT;
  v_other_super INTEGER;
BEGIN
  IF NOT public.admin_has_account_manage(p_actor_user_id) THEN
    RAISE EXCEPTION 'the actor lacks account.manage' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = p_actor_user_id THEN
    RAISE EXCEPTION 'an account cannot change its own roles' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO v_role_id FROM public.roles WHERE role_key = p_role_key;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'role not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_role_key = 'super_admin' THEN
    SELECT count(*) INTO v_other_super
    FROM public.app_users u
    JOIN public.user_roles ur ON ur.user_id = u.id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE r.role_key = 'super_admin' AND u.is_active AND u.id <> p_user_id;
    IF v_other_super = 0 THEN
      RAISE EXCEPTION 'the last active super admin cannot lose the role' USING ERRCODE = '23514';
    END IF;
  END IF;
  DELETE FROM public.user_roles WHERE user_id = p_user_id AND role_id = v_role_id;
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES (p_actor_user_id, 'account.role_removed', 'app_user', p_user_id::TEXT,
          jsonb_build_object('role_key', p_role_key));
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_reset_user_password(
  p_actor_user_id BIGINT,
  p_user_id BIGINT,
  p_password_hash TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
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
  INSERT INTO public.admin_credentials (user_id, login_name, password_hash, must_change_password, session_version, password_changed_at)
  SELECT u.id, u.identity_subject, p_password_hash, TRUE, 1, now()
  FROM public.app_users u WHERE u.id = p_user_id
  ON CONFLICT (user_id) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        must_change_password = TRUE,
        session_version = public.admin_credentials.session_version + 1,
        password_changed_at = now(),
        updated_at = now();
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES (p_actor_user_id, 'account.password_reset', 'app_user', p_user_id::TEXT,
          jsonb_build_object('must_change_password', TRUE));
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_change_own_password(
  p_actor_user_id BIGINT,
  p_password_hash TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_password_hash IS NULL OR p_password_hash !~ '^scrypt\$[0-9a-f]+\$[0-9a-f]+$' THEN
    RAISE EXCEPTION 'invalid password hash' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.admin_credentials (user_id, login_name, password_hash, must_change_password, session_version, password_changed_at)
  SELECT u.id, u.identity_subject, p_password_hash, FALSE, 1, now()
  FROM public.app_users u WHERE u.id = p_actor_user_id AND u.is_active
  ON CONFLICT (user_id) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        must_change_password = FALSE,
        session_version = public.admin_credentials.session_version + 1,
        password_changed_at = now(),
        updated_at = now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active account not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES (p_actor_user_id, 'account.password_changed', 'app_user', p_actor_user_id::TEXT,
          jsonb_build_object('sessions_revoked', TRUE));
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_has_account_manage(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_create_user(BIGINT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_user_active(BIGINT, BIGINT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_assign_user_role(BIGINT, BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_remove_user_role(BIGINT, BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reset_user_password(BIGINT, BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_change_own_password(BIGINT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_has_account_manage(BIGINT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.admin_create_user(BIGINT, TEXT, TEXT, TEXT, TEXT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.admin_set_user_active(BIGINT, BIGINT, BOOLEAN) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.admin_assign_user_role(BIGINT, BIGINT, TEXT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.admin_remove_user_role(BIGINT, BIGINT, TEXT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.admin_reset_user_password(BIGINT, BIGINT, TEXT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.admin_change_own_password(BIGINT, TEXT) TO iub_admin_runtime;

COMMIT;


