-- 0022_inventory_registration.sql
--
-- Alta manual de ejemplares institucionales. Es aditiva y requiere las
-- columnas y rutinas de verificación/publicación instaladas por 0020.
--
-- Reglas:
--   * todo ejemplar nace como unavailable;
--   * solo se publica si el operador pide publicar, existe una condición
--     física evaluada y una referencia de verificación, y el actor tiene los
--     permisos inventory.verify e inventory.publish;
--   * la creación es idempotente por clave y queda auditada.

DO $precondition$
BEGIN
  IF to_regclass('public.copies') IS NULL
     OR to_regclass('public.permissions') IS NULL
     OR to_regclass('public.inventory_movements') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'copies'
         AND column_name = 'verified_at'
     )
     OR to_regprocedure('public.verify_institutional_copy(bigint,bigint,text)') IS NULL
     OR to_regprocedure('public.publish_institutional_copy(bigint,bigint,uuid)') IS NULL THEN
    RAISE EXCEPTION
      '0022 requires the 0020 inventory verification and publication routines'
      USING ERRCODE = '55000';
  END IF;
END
$precondition$;

INSERT INTO public.permissions (permission_key, description) VALUES
  ('inventory.register', 'Dar de alta ejemplares institucionales manualmente')
ON CONFLICT (permission_key) DO NOTHING;

-- Propaga el permiso a los roles que ya administran inventario. No concede
-- acceso a roles públicos ni crea privilegios nuevos desde cero.
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, target.id
FROM public.role_permissions rp
JOIN public.permissions source ON source.id = rp.permission_id
JOIN public.permissions target ON target.permission_key = 'inventory.register'
WHERE source.permission_key IN ('inventory.batches.confirm', 'inventory.admit', 'inventory.enable')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, target.id
FROM public.role_permissions rp
JOIN public.permissions source ON source.id = rp.permission_id
JOIN public.permissions target ON target.permission_key = 'inventory.verify'
WHERE source.permission_key = 'inventory.admit'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, target.id
FROM public.role_permissions rp
JOIN public.permissions source ON source.id = rp.permission_id
JOIN public.permissions target ON target.permission_key = 'inventory.publish'
WHERE source.permission_key = 'inventory.enable'
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS copies_manual_registration_reference_uidx
  ON public.copies (provenance_reference)
  WHERE provenance_type = 'institutional'
    AND provenance_reference LIKE 'manual:%';

CREATE OR REPLACE FUNCTION public.register_institutional_copy(
  p_title TEXT,
  p_author TEXT,
  p_publisher TEXT,
  p_genre TEXT,
  p_isbn TEXT,
  p_isbn_normalized TEXT,
  p_inventory_code TEXT,
  p_location TEXT,
  p_physical_condition TEXT,
  p_verification_reference TEXT,
  p_publish BOOLEAN,
  p_actor_user_id BIGINT,
  p_idempotency_key UUID
)
RETURNS TABLE (
  copy_id BIGINT,
  bibliographic_record_id BIGINT,
  inventory_code TEXT,
  availability TEXT,
  verified BOOLEAN,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_existing public.copies%ROWTYPE;
  v_title TEXT;
  v_author TEXT;
  v_publisher TEXT;
  v_publisher_norm TEXT;
  v_genre TEXT;
  v_genre_norm TEXT;
  v_isbn TEXT;
  v_isbn_norm TEXT;
  v_code TEXT;
  v_location TEXT;
  v_condition TEXT;
  v_reference TEXT;
  v_publish BOOLEAN;
  v_publisher_id BIGINT;
  v_genre_id BIGINT;
  v_bib_id BIGINT;
  v_copy_id BIGINT;
  v_availability TEXT;
  v_verified BOOLEAN;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'inventory.register');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '23502';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('manual-institutional-copy:' || p_idempotency_key::TEXT, 0)
  );

  SELECT * INTO v_existing
  FROM public.copies c
  WHERE c.provenance_type = 'institutional'
    AND c.provenance_reference = 'manual:' || p_idempotency_key::TEXT
  FOR UPDATE;

  IF FOUND THEN
    SELECT c.availability, (c.verified_at IS NOT NULL)
    INTO v_availability, v_verified
    FROM public.copies c
    WHERE c.id = v_existing.id;

    copy_id := v_existing.id;
    bibliographic_record_id := v_existing.bibliographic_record_id;
    inventory_code := v_existing.inventory_code;
    availability := v_availability;
    verified := v_verified;
    created := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  v_title := btrim(coalesce(p_title, ''));
  v_author := btrim(coalesce(p_author, ''));
  v_publisher := nullif(btrim(coalesce(p_publisher, '')), '');
  v_genre := nullif(btrim(coalesce(p_genre, '')), '');
  v_isbn := nullif(btrim(coalesce(p_isbn, '')), '');
  v_isbn_norm := nullif(btrim(coalesce(p_isbn_normalized, '')), '');
  v_code := btrim(coalesce(p_inventory_code, ''));
  v_location := nullif(btrim(coalesce(p_location, '')), '');
  v_condition := lower(btrim(coalesce(p_physical_condition, 'unassessed')));
  v_reference := nullif(btrim(coalesce(p_verification_reference, '')), '');
  v_publish := coalesce(p_publish, FALSE);

  IF length(v_title) < 1 OR length(v_title) > 500 THEN
    RAISE EXCEPTION 'a title between 1 and 500 characters is required'
      USING ERRCODE = '23514';
  END IF;
  IF length(v_author) < 1 OR length(v_author) > 500 THEN
    RAISE EXCEPTION 'an author between 1 and 500 characters is required'
      USING ERRCODE = '23514';
  END IF;
  IF length(v_code) < 1 OR length(v_code) > 120 THEN
    RAISE EXCEPTION 'an inventory code between 1 and 120 characters is required'
      USING ERRCODE = '23514';
  END IF;
  IF v_location IS NOT NULL AND length(v_location) > 200 THEN
    RAISE EXCEPTION 'the location is too long' USING ERRCODE = '23514';
  END IF;
  IF v_reference IS NOT NULL AND length(v_reference) > 500 THEN
    RAISE EXCEPTION 'the verification reference is too long' USING ERRCODE = '23514';
  END IF;
  IF v_condition NOT IN ('excellent', 'good', 'fair', 'poor', 'unassessed') THEN
    RAISE EXCEPTION 'invalid physical condition' USING ERRCODE = '23514';
  END IF;
  IF (v_isbn IS NULL) <> (v_isbn_norm IS NULL) THEN
    RAISE EXCEPTION 'inconsistent ISBN' USING ERRCODE = '23514';
  END IF;
  IF v_isbn_norm IS NOT NULL
     AND v_isbn_norm !~ '^[0-9]{9}[0-9X]$|^[0-9]{13}$' THEN
    RAISE EXCEPTION 'invalid normalized ISBN' USING ERRCODE = '23514';
  END IF;

  IF v_publish THEN
    IF v_condition = 'unassessed' OR v_reference IS NULL THEN
      RAISE EXCEPTION 'publication requires an assessed condition and a verification reference'
        USING ERRCODE = '23514';
    END IF;
    PERFORM public.assert_actor_permission(p_actor_user_id, 'inventory.verify');
    PERFORM public.assert_actor_permission(p_actor_user_id, 'inventory.publish');
  END IF;

  IF v_publisher IS NOT NULL THEN
    v_publisher_norm := lower(regexp_replace(v_publisher, '\s+', ' ', 'g'));
    INSERT INTO public.publishers (name, normalized_name)
    VALUES (v_publisher, v_publisher_norm)
    ON CONFLICT (normalized_name) DO NOTHING;
    SELECT p.id INTO v_publisher_id
    FROM public.publishers p
    WHERE p.normalized_name = v_publisher_norm
    LIMIT 1;
  END IF;

  IF v_genre IS NOT NULL THEN
    v_genre_norm := lower(regexp_replace(v_genre, '\s+', ' ', 'g'));
    INSERT INTO public.genres (name, normalized_name)
    VALUES (v_genre, v_genre_norm)
    ON CONFLICT (normalized_name) DO NOTHING;
    SELECT g.id INTO v_genre_id
    FROM public.genres g
    WHERE g.normalized_name = v_genre_norm
    LIMIT 1;
  END IF;

  IF v_isbn_norm IS NOT NULL THEN
    SELECT b.id INTO v_bib_id
    FROM public.bibliographic_records b
    WHERE b.isbn_normalized = v_isbn_norm
    LIMIT 1;
  ELSE
    SELECT b.id INTO v_bib_id
    FROM public.bibliographic_records b
    WHERE b.isbn_normalized IS NULL
      AND lower(b.title) = lower(v_title)
      AND lower(b.author) = lower(v_author)
      AND b.publisher_id IS NOT DISTINCT FROM v_publisher_id
    LIMIT 1;
  END IF;

  IF v_bib_id IS NULL THEN
    INSERT INTO public.bibliographic_records
      (title, author, publisher_id, genre_id, isbn, isbn_normalized)
    VALUES
      (v_title, v_author, v_publisher_id, v_genre_id, v_isbn, v_isbn_norm)
    RETURNING id INTO v_bib_id;
  END IF;

  INSERT INTO public.copies
    (bibliographic_record_id, inventory_code, physical_condition, availability,
     location, provenance_type, provenance_reference)
  VALUES
    (v_bib_id, v_code, v_condition, 'unavailable',
     v_location, 'institutional', 'manual:' || p_idempotency_key::TEXT)
  RETURNING id INTO v_copy_id;

  INSERT INTO public.inventory_movements
    (copy_id, movement_type, new_availability, performed_by, reason)
  VALUES
    (v_copy_id, 'received', 'unavailable', p_actor_user_id,
     'manual institutional registration');

  IF v_publish THEN
    PERFORM public.verify_institutional_copy(v_copy_id, p_actor_user_id, v_reference);
    PERFORM public.publish_institutional_copy(
      v_copy_id,
      p_actor_user_id,
      md5(p_idempotency_key::TEXT || ':publish')::UUID
    );
  END IF;

  SELECT c.availability, (c.verified_at IS NOT NULL)
  INTO v_availability, v_verified
  FROM public.copies c
  WHERE c.id = v_copy_id;

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id,
     'inventory.manual_copy_registered',
     'copy',
     v_copy_id::TEXT,
     jsonb_build_object(
       'inventory_code', v_code,
       'published', v_publish,
       'idempotency_key', p_idempotency_key
     ));

  copy_id := v_copy_id;
  bibliographic_record_id := v_bib_id;
  inventory_code := v_code;
  availability := v_availability;
  verified := v_verified;
  created := TRUE;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.register_institutional_copy(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, BIGINT, UUID
) FROM PUBLIC, iub_public_runtime;
GRANT EXECUTE ON FUNCTION public.register_institutional_copy(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, BIGINT, UUID
) TO iub_admin_runtime;
