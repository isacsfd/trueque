-- Eleventh versioned migration. Administrative account management and a
-- database-level guard for request approval.
--
-- Accounts are actors in PostgreSQL. Authentication credentials remain in the
-- private deployment configuration (ADMIN_USERS) or in the future OIDC
-- provider; this migration never stores passwords or hashes.
-- Additive: no inventory, containment or evidence table is modified.

-- ---------------------------------------------------------------------------
-- 1. Read-only account directory for authorized account managers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_list_accounts(p_actor_user_id BIGINT)
RETURNS TABLE (
  user_id BIGINT,
  identity_issuer TEXT,
  identity_subject TEXT,
  email TEXT,
  is_active BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  roles JSONB,
  permissions JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'account.manage');

  RETURN QUERY
  SELECT
    u.id,
    u.identity_issuer,
    u.identity_subject,
    u.email,
    u.is_active,
    u.created_at,
    u.updated_at,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'roleId', r.id::TEXT,
          'roleKey', r.role_key,
          'displayName', r.display_name,
          'description', r.description
        ) ORDER BY r.role_key
      )
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id
      WHERE ur.user_id = u.id
    ), '[]'::JSONB),
    COALESCE((
      SELECT jsonb_agg(DISTINCT p.permission_key ORDER BY p.permission_key)
      FROM public.user_roles ur
      JOIN public.role_permissions rp ON rp.role_id = ur.role_id
      JOIN public.permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = u.id
    ), '[]'::JSONB)
  FROM public.app_users u
  ORDER BY u.is_active DESC, lower(u.identity_subject), u.id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Create a database actor without creating credentials
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_create_account(
  p_actor_user_id BIGINT,
  p_identity_issuer TEXT,
  p_identity_subject TEXT,
  p_email TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_issuer TEXT;
  v_subject TEXT;
  v_email TEXT;
  v_id BIGINT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'account.manage');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  v_issuer := btrim(coalesce(p_identity_issuer, 'local'));
  v_subject := btrim(coalesce(p_identity_subject, ''));
  v_email := nullif(lower(btrim(coalesce(p_email, ''))), '');

  IF length(v_issuer) < 1 OR length(v_issuer) > 250 THEN
    RAISE EXCEPTION 'invalid identity issuer' USING ERRCODE = '23514';
  END IF;
  IF length(v_subject) < 3 OR length(v_subject) > 200 THEN
    RAISE EXCEPTION 'invalid identity subject' USING ERRCODE = '23514';
  END IF;
  IF v_email IS NOT NULL AND (
    length(v_email) > 320
    OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ) THEN
    RAISE EXCEPTION 'invalid administrative email' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.app_users u
    WHERE u.identity_issuer = v_issuer AND u.identity_subject = v_subject
  ) THEN
    RAISE EXCEPTION 'an account with that identity already exists' USING ERRCODE = '23505';
  END IF;
  IF v_email IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.app_users u WHERE u.email_normalized = v_email
  ) THEN
    RAISE EXCEPTION 'an account with that email already exists' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.app_users
    (identity_issuer, identity_subject, email, email_normalized, is_active)
  VALUES
    (v_issuer, v_subject, v_email, v_email, TRUE)
  RETURNING id INTO v_id;

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'account.created', 'app_user', v_id::TEXT,
     jsonb_build_object('identity_issuer', v_issuer, 'identity_subject', v_subject));

  RETURN v_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Activate or deactivate an account, protecting self and the last manager
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_set_account_active(
  p_actor_user_id BIGINT,
  p_user_id BIGINT,
  p_is_active BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_user public.app_users%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'account.manage');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT * INTO v_user FROM public.app_users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_user.is_active = p_is_active THEN
    RETURN;
  END IF;
  IF NOT p_is_active AND p_user_id = p_actor_user_id THEN
    RAISE EXCEPTION 'an account cannot deactivate its own session' USING ERRCODE = '42501';
  END IF;
  IF NOT p_is_active AND v_user.is_active
     AND EXISTS (
       SELECT 1
       FROM public.user_roles ur
       JOIN public.role_permissions rp ON rp.role_id = ur.role_id
       JOIN public.permissions p ON p.id = rp.permission_id
       WHERE ur.user_id = p_user_id AND p.permission_key = 'account.manage'
     )
     AND NOT EXISTS (
       SELECT 1
       FROM public.app_users u
       JOIN public.user_roles ur ON ur.user_id = u.id
       JOIN public.role_permissions rp ON rp.role_id = ur.role_id
       JOIN public.permissions p ON p.id = rp.permission_id
       WHERE u.is_active AND u.id <> p_user_id AND p.permission_key = 'account.manage'
     ) THEN
    RAISE EXCEPTION 'the last active account manager cannot be deactivated' USING ERRCODE = '23514';
  END IF;

  UPDATE public.app_users SET is_active = p_is_active WHERE id = p_user_id;

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id,
     CASE WHEN p_is_active THEN 'account.activated' ELSE 'account.deactivated' END,
     'app_user', p_user_id::TEXT,
     jsonb_build_object('is_active', p_is_active));
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Assign or remove roles without privilege escalation
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_assign_role(
  p_actor_user_id BIGINT,
  p_user_id BIGINT,
  p_role_id BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_role public.roles%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'account.manage');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  IF p_user_id = p_actor_user_id THEN
    RAISE EXCEPTION 'an account cannot change its own roles' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'account not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_role FROM public.roles WHERE id = p_role_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'role not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.role_permissions rp
    WHERE rp.role_id = p_role_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        JOIN public.role_permissions actor_rp ON actor_rp.role_id = ur.role_id
        WHERE ur.user_id = p_actor_user_id
          AND actor_rp.permission_id = rp.permission_id
      )
  ) THEN
    RAISE EXCEPTION 'cannot grant a role with permissions the actor does not hold'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = p_user_id AND role_id = p_role_id
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.user_roles (user_id, role_id, assigned_by)
  VALUES (p_user_id, p_role_id, p_actor_user_id);

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'account.role_assigned', 'app_user', p_user_id::TEXT,
     jsonb_build_object('role_id', p_role_id, 'role_key', v_role.role_key));
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_remove_role(
  p_actor_user_id BIGINT,
  p_user_id BIGINT,
  p_role_id BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_user public.app_users%ROWTYPE;
  v_role public.roles%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'account.manage');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  IF p_user_id = p_actor_user_id THEN
    RAISE EXCEPTION 'an account cannot change its own roles' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_user FROM public.app_users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_role FROM public.roles WHERE id = p_role_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'role not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_user.is_active
     AND EXISTS (
       SELECT 1
       FROM public.role_permissions rp
       JOIN public.permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = p_role_id AND p.permission_key = 'account.manage'
     )
     AND NOT EXISTS (
       SELECT 1
       FROM public.app_users u
       JOIN public.user_roles ur ON ur.user_id = u.id
       JOIN public.role_permissions rp ON rp.role_id = ur.role_id
       JOIN public.permissions p ON p.id = rp.permission_id
       WHERE u.is_active AND u.id <> p_user_id AND p.permission_key = 'account.manage'
     ) THEN
    RAISE EXCEPTION 'the last active account manager cannot lose that role' USING ERRCODE = '23514';
  END IF;

  DELETE FROM public.user_roles WHERE user_id = p_user_id AND role_id = p_role_id;
  IF FOUND THEN
    INSERT INTO public.audit_events
      (actor_user_id, event_type, resource_type, resource_id, metadata)
    VALUES
      (p_actor_user_id, 'account.role_removed', 'app_user', p_user_id::TEXT,
       jsonb_build_object('role_id', p_role_id, 'role_key', v_role.role_key));
  END IF;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Request approval cannot target an unavailable or ineligible copy
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_request_copy_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_copy public.copies%ROWTYPE;
  v_has_active_reservation BOOLEAN;
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
          AND r.status = 'active'
          AND r.expires_at > clock_timestamp()
      ) INTO v_has_active_reservation;
      IF NOT v_has_active_reservation THEN
        RAISE EXCEPTION 'the requested copy has no active reservation'
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

-- Every approval or rejection must leave a human-readable reason in history.
CREATE OR REPLACE FUNCTION public.guard_request_decision_reason()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.new_status IN ('approved', 'rejected')
     AND length(btrim(coalesce(NEW.reason, ''))) < 3 THEN
    RAISE EXCEPTION 'a decision reason is required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS request_status_history_decision_reason_guard
  ON public.request_status_history;
CREATE TRIGGER request_status_history_decision_reason_guard
  BEFORE INSERT ON public.request_status_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_request_decision_reason();

-- ---------------------------------------------------------------------------
-- 6. Least-privilege grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.admin_list_accounts(BIGINT)
  FROM PUBLIC, iub_public_runtime;
REVOKE ALL ON FUNCTION public.admin_create_account(BIGINT, TEXT, TEXT, TEXT)
  FROM PUBLIC, iub_public_runtime;
REVOKE ALL ON FUNCTION public.admin_set_account_active(BIGINT, BIGINT, BOOLEAN)
  FROM PUBLIC, iub_public_runtime;
REVOKE ALL ON FUNCTION public.admin_assign_role(BIGINT, BIGINT, BIGINT)
  FROM PUBLIC, iub_public_runtime;
REVOKE ALL ON FUNCTION public.admin_remove_role(BIGINT, BIGINT, BIGINT)
  FROM PUBLIC, iub_public_runtime;
REVOKE ALL ON FUNCTION public.guard_request_copy_approval()
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;
REVOKE ALL ON FUNCTION public.guard_request_decision_reason()
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;

GRANT EXECUTE ON FUNCTION public.assert_actor_permission(BIGINT, TEXT) TO iub_admin_runtime;
GRANT SELECT ON public.request_status_history, public.available_catalog TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.admin_list_accounts(BIGINT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.admin_create_account(BIGINT, TEXT, TEXT, TEXT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.admin_set_account_active(BIGINT, BIGINT, BOOLEAN) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.admin_assign_role(BIGINT, BIGINT, BIGINT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.admin_remove_role(BIGINT, BIGINT, BIGINT) TO iub_admin_runtime;
