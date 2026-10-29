-- Tenth versioned migration. Inventory batch prevalidation and safe import.
-- Additive: stores batch metadata, original file reference and per-row results.
-- Confirmed imports create institutional copies only as unavailable/unassessed and
-- never create movements, receptions, acceptances or enablement.

CREATE TABLE public.inventory_batches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_name TEXT NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  file_sha256 BYTEA NOT NULL CHECK (octet_length(file_sha256) = 32),
  file_size INTEGER NOT NULL CHECK (file_size BETWEEN 1 AND 10485760),
  storage_key TEXT NOT NULL UNIQUE CHECK (storage_key ~ '^[A-Za-z0-9._-]{1,120}$'),
  sheet_name TEXT NOT NULL CHECK (length(btrim(sheet_name)) BETWEEN 1 AND 200),
  header_row INTEGER NOT NULL CHECK (header_row > 0),
  column_mapping JSONB NOT NULL CHECK (jsonb_typeof(column_mapping) = 'object'),
  status TEXT NOT NULL DEFAULT 'prevalidated' CHECK (status IN ('prevalidated', 'confirmed', 'cancelled', 'failed')),
  total_rows INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  valid_rows INTEGER NOT NULL DEFAULT 0 CHECK (valid_rows >= 0),
  warning_rows INTEGER NOT NULL DEFAULT 0 CHECK (warning_rows >= 0),
  rejected_rows INTEGER NOT NULL DEFAULT 0 CHECK (rejected_rows >= 0),
  duplicate_rows INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_rows >= 0),
  inserted_rows INTEGER NOT NULL DEFAULT 0 CHECK (inserted_rows >= 0),
  reused_rows INTEGER NOT NULL DEFAULT 0 CHECK (reused_rows >= 0),
  observations TEXT CHECK (observations IS NULL OR length(observations) <= 3000),
  created_by BIGINT NOT NULL REFERENCES public.app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  confirmed_by BIGINT REFERENCES public.app_users(id),
  confirmed_at TIMESTAMPTZ,
  cancelled_by BIGINT REFERENCES public.app_users(id),
  cancelled_at TIMESTAMPTZ,
  idempotency_key UUID NOT NULL UNIQUE,
  CHECK (status <> 'confirmed' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK (status <> 'cancelled' OR (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL))
);

CREATE INDEX inventory_batches_created_idx
  ON public.inventory_batches (created_at DESC, id DESC);
CREATE INDEX inventory_batches_hash_idx
  ON public.inventory_batches (file_sha256);

CREATE TABLE public.inventory_batch_rows (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES public.inventory_batches(id),
  source_row INTEGER NOT NULL CHECK (source_row > 0),
  raw_row JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(raw_row) = 'object'),
  mapped_data JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(mapped_data) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('valid', 'warning', 'rejected', 'duplicate', 'inserted', 'reused', 'skipped')),
  errors JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(errors) = 'array'),
  warnings JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(warnings) = 'array'),
  inventory_code TEXT,
  bibliographic_record_id BIGINT REFERENCES public.bibliographic_records(id),
  copy_id BIGINT REFERENCES public.copies(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (batch_id, source_row)
);

CREATE INDEX inventory_batch_rows_batch_status_idx
  ON public.inventory_batch_rows (batch_id, status, source_row);

-- One batch row can only create one institutional copy, even across retries.
CREATE UNIQUE INDEX copies_inventory_batch_reference_uidx
  ON public.copies (provenance_reference)
  WHERE provenance_type = 'institutional'
    AND provenance_reference LIKE 'inventory-batch:%';

REVOKE ALL ON public.inventory_batches, public.inventory_batch_rows
  FROM PUBLIC, iub_public_runtime;
GRANT SELECT ON public.inventory_batches, public.inventory_batch_rows
  TO iub_admin_runtime;

INSERT INTO public.permissions (permission_key, description) VALUES
  ('inventory.batches.import', 'Prevalidar y cancelar lotes de inventario'),
  ('inventory.batches.confirm', 'Confirmar la importacion de un lote prevalidado'),
  ('inventory.batches.read', 'Consultar historial y detalle de lotes de inventario'),
  ('stats.read', 'Consultar estadisticas administrativas agregadas'),
  ('account.manage', 'Gestionar la propia cuenta administrativa')
ON CONFLICT (permission_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1. Persist a prevalidation (no inventory writes)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.store_inventory_batch(
  p_file_name TEXT,
  p_file_sha256 BYTEA,
  p_file_size INTEGER,
  p_sheet_name TEXT,
  p_header_row INTEGER,
  p_column_mapping JSONB,
  p_rows JSONB,
  p_actor_user_id BIGINT,
  p_idempotency_key UUID,
  p_storage_key TEXT,
  p_observations TEXT
)
RETURNS TABLE (
  batch_id BIGINT,
  status TEXT,
  total_rows INTEGER,
  valid_rows INTEGER,
  warning_rows INTEGER,
  rejected_rows INTEGER,
  duplicate_rows INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_existing public.inventory_batches%ROWTYPE;
  v_id BIGINT;
  v_total INTEGER;
  v_valid INTEGER;
  v_warning INTEGER;
  v_rejected INTEGER;
  v_duplicate INTEGER;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'inventory.batches.import');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '23502';
  END IF;
  IF p_file_sha256 IS NULL OR octet_length(p_file_sha256) <> 32 THEN
    RAISE EXCEPTION 'invalid file digest' USING ERRCODE = '23514';
  END IF;
  IF p_file_name IS NULL OR length(btrim(p_file_name)) < 1 THEN
    RAISE EXCEPTION 'a file name is required' USING ERRCODE = '23514';
  END IF;
  IF p_file_size IS NULL OR p_file_size < 1 OR p_file_size > 10485760 THEN
    RAISE EXCEPTION 'invalid file size' USING ERRCODE = '23514';
  END IF;
  IF p_sheet_name IS NULL OR length(btrim(p_sheet_name)) < 1 THEN
    RAISE EXCEPTION 'a sheet name is required' USING ERRCODE = '23514';
  END IF;
  IF p_header_row IS NULL OR p_header_row < 1 THEN
    RAISE EXCEPTION 'invalid header row' USING ERRCODE = '23514';
  END IF;
  IF p_column_mapping IS NULL OR jsonb_typeof(p_column_mapping) <> 'object' THEN
    RAISE EXCEPTION 'a column mapping is required' USING ERRCODE = '23514';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows must be an array' USING ERRCODE = '23514';
  END IF;
  IF p_storage_key IS NULL OR p_storage_key !~ '^[A-Za-z0-9._-]{1,120}$' THEN
    RAISE EXCEPTION 'invalid storage key' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_existing
  FROM public.inventory_batches
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.file_sha256 IS DISTINCT FROM p_file_sha256 THEN
      RAISE EXCEPTION 'batch idempotency key conflict' USING ERRCODE = '23505';
    END IF;
    batch_id := v_existing.id;
    status := v_existing.status;
    total_rows := v_existing.total_rows;
    valid_rows := v_existing.valid_rows;
    warning_rows := v_existing.warning_rows;
    rejected_rows := v_existing.rejected_rows;
    duplicate_rows := v_existing.duplicate_rows;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT count(*) INTO v_total FROM jsonb_array_elements(p_rows);
  IF v_total = 0 THEN
    RAISE EXCEPTION 'the batch has no rows' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) AS value
    WHERE value->>'status' NOT IN ('valid', 'warning', 'rejected', 'duplicate')
  ) THEN
    RAISE EXCEPTION 'invalid prevalidation row status' USING ERRCODE = '23514';
  END IF;

  SELECT count(*) FILTER (WHERE value->>'status' = 'valid'),
         count(*) FILTER (WHERE value->>'status' = 'warning'),
         count(*) FILTER (WHERE value->>'status' = 'rejected'),
         count(*) FILTER (WHERE value->>'status' = 'duplicate')
  INTO v_valid, v_warning, v_rejected, v_duplicate
  FROM jsonb_array_elements(p_rows) AS value;

  INSERT INTO public.inventory_batches
    (file_name, file_sha256, file_size, storage_key, sheet_name, header_row,
     column_mapping, status, total_rows, valid_rows, warning_rows, rejected_rows,
     duplicate_rows, observations, created_by, idempotency_key)
  VALUES
    (btrim(p_file_name), p_file_sha256, p_file_size, p_storage_key,
     btrim(p_sheet_name), p_header_row, p_column_mapping, 'prevalidated',
     v_total, v_valid, v_warning, v_rejected, v_duplicate,
     nullif(btrim(p_observations), ''), p_actor_user_id,
     p_idempotency_key)
  RETURNING id INTO v_id;

  INSERT INTO public.inventory_batch_rows
    (batch_id, source_row, raw_row, mapped_data, status, errors, warnings, inventory_code)
  SELECT
    v_id,
    (value->>'source_row')::INTEGER,
    coalesce(value->'raw', '{}'::JSONB),
    coalesce(value->'mapped', '{}'::JSONB),
    value->>'status',
    coalesce(value->'errors', '[]'::JSONB),
    coalesce(value->'warnings', '[]'::JSONB),
    nullif(btrim(value->>'inventory_code'), '')
  FROM jsonb_array_elements(p_rows) AS value;

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'inventory.batch_prevalidated', 'inventory_batch', v_id::TEXT,
     jsonb_build_object('file_name', p_file_name, 'sha256', encode(p_file_sha256, 'hex'),
                        'total_rows', v_total, 'valid_rows', v_valid,
                        'warning_rows', v_warning, 'rejected_rows', v_rejected));

  batch_id := v_id;
  status := 'prevalidated';
  total_rows := v_total;
  valid_rows := v_valid;
  warning_rows := v_warning;
  rejected_rows := v_rejected;
  duplicate_rows := v_duplicate;
  RETURN NEXT;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Confirm a prevalidated batch atomically
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.confirm_inventory_batch(
  p_batch_id BIGINT,
  p_actor_user_id BIGINT,
  p_idempotency_key UUID
)
RETURNS TABLE (
  batch_id BIGINT,
  status TEXT,
  inserted_rows INTEGER,
  reused_rows INTEGER,
  skipped_rows INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_batch public.inventory_batches%ROWTYPE;
  v_row RECORD;
  v_title TEXT;
  v_author TEXT;
  v_publisher TEXT;
  v_genre TEXT;
  v_isbn TEXT;
  v_isbn_normalized TEXT;
  v_inventory_code TEXT;
  v_location TEXT;
  v_publisher_id BIGINT;
  v_genre_id BIGINT;
  v_bib_id BIGINT;
  v_copy_id BIGINT;
  v_inserted INTEGER := 0;
  v_reused INTEGER := 0;
  v_skipped INTEGER := 0;
  v_existing_bib BOOLEAN;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'inventory.batches.confirm');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_batch FROM public.inventory_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_batch.status = 'confirmed' THEN
    batch_id := v_batch.id;
    status := v_batch.status;
    inserted_rows := v_batch.inserted_rows;
    reused_rows := v_batch.reused_rows;
    skipped_rows := v_batch.rejected_rows + v_batch.duplicate_rows;
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_batch.status <> 'prevalidated' THEN
    RAISE EXCEPTION 'batch cannot be confirmed from status %', v_batch.status USING ERRCODE = '23514';
  END IF;

  FOR v_row IN
    SELECT * FROM public.inventory_batch_rows
    WHERE public.inventory_batch_rows.batch_id = p_batch_id
      AND public.inventory_batch_rows.status IN ('valid', 'warning')
    ORDER BY source_row
    FOR UPDATE
  LOOP
    v_title := btrim(coalesce(v_row.mapped_data->>'title', ''));
    v_author := btrim(coalesce(v_row.mapped_data->>'author', ''));
    IF v_title = '' OR v_author = '' THEN
      RAISE EXCEPTION 'row % has no title or author', v_row.source_row USING ERRCODE = '23514';
    END IF;

    v_publisher := nullif(btrim(v_row.mapped_data->>'publisher'), '');
    v_genre := nullif(btrim(v_row.mapped_data->>'genre'), '');
    v_isbn := nullif(btrim(v_row.mapped_data->>'isbn'), '');
    v_isbn_normalized := nullif(btrim(v_row.mapped_data->>'isbn_normalized'), '');
    IF (v_isbn IS NULL) <> (v_isbn_normalized IS NULL) THEN
      RAISE EXCEPTION 'row % has inconsistent ISBN', v_row.source_row USING ERRCODE = '23514';
    END IF;
    v_inventory_code := nullif(btrim(v_row.mapped_data->>'inventory_code'), '');
    IF v_inventory_code IS NULL THEN
      v_inventory_code := 'IUB-LOTE-' || p_batch_id::TEXT || '-' || v_row.source_row::TEXT;
    END IF;
    v_location := nullif(btrim(v_row.mapped_data->>'location'), '');

    IF v_publisher IS NOT NULL THEN
      SELECT id INTO v_publisher_id FROM public.publishers WHERE normalized_name = lower(regexp_replace(v_publisher, '\s+', ' ', 'g'));
      IF NOT FOUND THEN
        INSERT INTO public.publishers (name, normalized_name)
        VALUES (v_publisher, lower(regexp_replace(v_publisher, '\s+', ' ', 'g')))
        ON CONFLICT (normalized_name) DO NOTHING;
        SELECT id INTO v_publisher_id FROM public.publishers WHERE normalized_name = lower(regexp_replace(v_publisher, '\s+', ' ', 'g'));
      END IF;
    ELSE
      v_publisher_id := NULL;
    END IF;

    IF v_genre IS NOT NULL THEN
      SELECT id INTO v_genre_id FROM public.genres WHERE normalized_name = lower(regexp_replace(v_genre, '\s+', ' ', 'g'));
      IF NOT FOUND THEN
        INSERT INTO public.genres (name, normalized_name)
        VALUES (v_genre, lower(regexp_replace(v_genre, '\s+', ' ', 'g')))
        ON CONFLICT (normalized_name) DO NOTHING;
        SELECT id INTO v_genre_id FROM public.genres WHERE normalized_name = lower(regexp_replace(v_genre, '\s+', ' ', 'g'));
      END IF;
    ELSE
      v_genre_id := NULL;
    END IF;

    v_existing_bib := FALSE;
    IF v_isbn_normalized IS NOT NULL THEN
      SELECT id INTO v_bib_id FROM public.bibliographic_records WHERE isbn_normalized = v_isbn_normalized LIMIT 1;
    ELSE
      SELECT id INTO v_bib_id
      FROM public.bibliographic_records
      WHERE isbn_normalized IS NULL
        AND lower(title) = lower(v_title)
        AND lower(author) = lower(v_author)
        AND COALESCE(publisher_id, 0) = COALESCE(v_publisher_id, 0)
      LIMIT 1;
    END IF;
    IF FOUND THEN
      v_existing_bib := TRUE;
    ELSE
      INSERT INTO public.bibliographic_records
        (title, author, publisher_id, genre_id, isbn, isbn_normalized)
      VALUES
        (v_title, v_author, v_publisher_id, v_genre_id, v_isbn, v_isbn_normalized)
      RETURNING id INTO v_bib_id;
    END IF;

    IF EXISTS (SELECT 1 FROM public.copies WHERE inventory_code = v_inventory_code) THEN
      RAISE EXCEPTION 'inventory code already exists: %', v_inventory_code USING ERRCODE = '23505';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.copies
      WHERE provenance_type = 'institutional'
        AND provenance_reference = 'inventory-batch:' || p_batch_id::TEXT || ':row:' || v_row.source_row::TEXT
    ) THEN
      RAISE EXCEPTION 'the batch row already has a copy' USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.copies
      (bibliographic_record_id, inventory_code, physical_condition, availability,
       location, provenance_type, provenance_reference)
    VALUES
      (v_bib_id, v_inventory_code, 'unassessed', 'unavailable', v_location,
       'institutional', 'inventory-batch:' || p_batch_id::TEXT || ':row:' || v_row.source_row::TEXT)
    RETURNING id INTO v_copy_id;

    UPDATE public.inventory_batch_rows
    SET status = CASE WHEN v_existing_bib THEN 'reused' ELSE 'inserted' END,
        bibliographic_record_id = v_bib_id,
        copy_id = v_copy_id
    WHERE id = v_row.id;

    IF v_existing_bib THEN
      v_reused := v_reused + 1;
    ELSE
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  UPDATE public.inventory_batches
  SET status = 'confirmed',
      confirmed_by = p_actor_user_id,
      confirmed_at = clock_timestamp(),
      inserted_rows = v_inserted,
      reused_rows = v_reused
  WHERE id = p_batch_id;

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'inventory.batch_confirmed', 'inventory_batch', p_batch_id::TEXT,
     jsonb_build_object('inserted_rows', v_inserted, 'reused_rows', v_reused,
                        'skipped_rows', v_batch.rejected_rows + v_batch.duplicate_rows,
                        'idempotency_key', p_idempotency_key));

  batch_id := p_batch_id;
  status := 'confirmed';
  inserted_rows := v_inserted;
  reused_rows := v_reused;
  skipped_rows := v_batch.rejected_rows + v_batch.duplicate_rows;
  RETURN NEXT;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Cancel a prevalidation without inventory changes
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cancel_inventory_batch(
  p_batch_id BIGINT,
  p_actor_user_id BIGINT,
  p_idempotency_key UUID
)
RETURNS TABLE (batch_id BIGINT, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_batch public.inventory_batches%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'inventory.batches.import');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_batch FROM public.inventory_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_batch.status = 'cancelled' THEN
    batch_id := v_batch.id;
    status := v_batch.status;
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_batch.status <> 'prevalidated' THEN
    RAISE EXCEPTION 'only a prevalidated batch can be cancelled' USING ERRCODE = '23514';
  END IF;

  UPDATE public.inventory_batches
  SET status = 'cancelled', cancelled_by = p_actor_user_id, cancelled_at = clock_timestamp()
  WHERE id = p_batch_id;

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'inventory.batch_cancelled', 'inventory_batch', p_batch_id::TEXT,
     jsonb_build_object('idempotency_key', p_idempotency_key));

  batch_id := p_batch_id;
  status := 'cancelled';
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.store_inventory_batch(TEXT, BYTEA, INTEGER, TEXT, INTEGER, JSONB, JSONB, BIGINT, UUID, TEXT, TEXT)
  FROM PUBLIC, iub_public_runtime;
GRANT EXECUTE ON FUNCTION public.store_inventory_batch(TEXT, BYTEA, INTEGER, TEXT, INTEGER, JSONB, JSONB, BIGINT, UUID, TEXT, TEXT)
  TO iub_admin_runtime;

REVOKE ALL ON FUNCTION public.confirm_inventory_batch(BIGINT, BIGINT, UUID)
  FROM PUBLIC, iub_public_runtime;
GRANT EXECUTE ON FUNCTION public.confirm_inventory_batch(BIGINT, BIGINT, UUID)
  TO iub_admin_runtime;

REVOKE ALL ON FUNCTION public.cancel_inventory_batch(BIGINT, BIGINT, UUID)
  FROM PUBLIC, iub_public_runtime;
GRANT EXECUTE ON FUNCTION public.cancel_inventory_batch(BIGINT, BIGINT, UUID)
  TO iub_admin_runtime;
