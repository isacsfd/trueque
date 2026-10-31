-- 0023_inventory_batch_autopublish.sql
--
-- Extiende la confirmación de lotes Excel para publicar automáticamente las
-- filas que ya cumplen las condiciones de elegibilidad:
--   * estado físico evaluado (excellent/good/fair/poor);
--   * referencia de verificación no vacía;
--   * actor con permisos inventory.verify e inventory.publish.
--
-- Las filas restantes se importan como unavailable y permanecen en la cola de
-- verificación. Esta migración depende de 0010 (lotes) y 0020 (verificación).
-- No se aplica sobre el baseline de producción sin 0010.

DO $precondition$
BEGIN
  IF to_regclass('public.inventory_batches') IS NULL
     OR to_regclass('public.inventory_batch_rows') IS NULL
     OR to_regprocedure('public.confirm_inventory_batch(bigint,bigint,uuid)') IS NULL
     OR to_regprocedure('public.verify_institutional_copy(bigint,bigint,text)') IS NULL
     OR to_regprocedure('public.publish_institutional_copy(bigint,bigint,uuid)') IS NULL THEN
    RAISE EXCEPTION
      '0023 requires 0010 inventory batches and 0020 verification/publication routines'
      USING ERRCODE = '55000';
  END IF;
END
$precondition$;

CREATE OR REPLACE FUNCTION public.confirm_inventory_batch_with_publication(
  p_batch_id BIGINT,
  p_actor_user_id BIGINT,
  p_idempotency_key UUID
)
RETURNS TABLE (
  batch_id BIGINT,
  status TEXT,
  inserted_rows INTEGER,
  reused_rows INTEGER,
  skipped_rows INTEGER,
  auto_published INTEGER,
  auto_skipped INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_confirmed RECORD;
  v_row RECORD;
  v_copy public.copies%ROWTYPE;
  v_can_publish BOOLEAN;
  v_eligible INTEGER := 0;
  v_published INTEGER := 0;
  v_pending INTEGER := 0;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'inventory.batches.confirm');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT * INTO v_confirmed
  FROM public.confirm_inventory_batch(p_batch_id, p_actor_user_id, p_idempotency_key);

  SELECT
    EXISTS (
      SELECT 1
      FROM public.user_roles ur
      JOIN public.role_permissions rp ON rp.role_id = ur.role_id
      JOIN public.permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = p_actor_user_id
        AND p.permission_key = 'inventory.verify'
    )
    AND EXISTS (
      SELECT 1
      FROM public.user_roles ur
      JOIN public.role_permissions rp ON rp.role_id = ur.role_id
      JOIN public.permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = p_actor_user_id
        AND p.permission_key = 'inventory.publish'
    )
  INTO v_can_publish;

  SELECT count(*)::INTEGER INTO v_eligible
  FROM public.inventory_batch_rows r
  WHERE r.batch_id = p_batch_id
    AND r.copy_id IS NOT NULL
    AND lower(coalesce(r.mapped_data->>'physical_condition', ''))
        IN ('excellent', 'good', 'fair', 'poor')
    AND nullif(btrim(coalesce(r.mapped_data->>'verification_reference', '')), '') IS NOT NULL;

  IF v_can_publish THEN
    FOR v_row IN
      SELECT r.source_row,
             r.copy_id,
             lower(coalesce(r.mapped_data->>'physical_condition', '')) AS physical_condition,
             nullif(btrim(coalesce(r.mapped_data->>'verification_reference', '')), '') AS verification_reference
      FROM public.inventory_batch_rows r
      WHERE r.batch_id = p_batch_id
        AND r.copy_id IS NOT NULL
        AND lower(coalesce(r.mapped_data->>'physical_condition', ''))
            IN ('excellent', 'good', 'fair', 'poor')
        AND nullif(btrim(coalesce(r.mapped_data->>'verification_reference', '')), '') IS NOT NULL
      ORDER BY r.source_row
    LOOP
      SELECT * INTO v_copy
      FROM public.copies c
      WHERE c.id = v_row.copy_id
      FOR UPDATE;

      IF NOT FOUND OR v_copy.availability = 'available' THEN
        CONTINUE;
      END IF;
      IF v_copy.availability <> 'unavailable' THEN
        CONTINUE;
      END IF;
      IF v_copy.physical_condition <> 'unassessed'
         AND v_copy.physical_condition <> v_row.physical_condition THEN
        CONTINUE;
      END IF;

      IF v_copy.physical_condition = 'unassessed' THEN
        UPDATE public.copies
        SET physical_condition = v_row.physical_condition
        WHERE id = v_copy.id;
      END IF;

      IF v_copy.verified_at IS NULL THEN
        PERFORM public.verify_institutional_copy(
          v_copy.id,
          p_actor_user_id,
          v_row.verification_reference
        );
      END IF;

      PERFORM public.publish_institutional_copy(
        v_copy.id,
        p_actor_user_id,
        md5(
          p_idempotency_key::TEXT || ':batch:' || p_batch_id::TEXT ||
          ':row:' || v_row.source_row::TEXT
        )::UUID
      );
      v_published := v_published + 1;
    END LOOP;
  END IF;

  SELECT count(*)::INTEGER INTO v_pending
  FROM public.inventory_batch_rows r
  JOIN public.copies c ON c.id = r.copy_id
  WHERE r.batch_id = p_batch_id
    AND c.availability <> 'available';

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id,
     'inventory.batch_auto_publish_completed',
     'inventory_batch',
     p_batch_id::TEXT,
     jsonb_build_object(
       'eligible_rows', v_eligible,
       'auto_published', v_published,
       'pending_publication', v_pending,
       'actor_can_publish', v_can_publish,
       'idempotency_key', p_idempotency_key
     ));

  batch_id := v_confirmed.batch_id;
  status := v_confirmed.status;
  inserted_rows := v_confirmed.inserted_rows;
  reused_rows := v_confirmed.reused_rows;
  skipped_rows := v_confirmed.skipped_rows;
  auto_published := v_published;
  auto_skipped := v_pending;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.confirm_inventory_batch_with_publication(BIGINT, BIGINT, UUID)
  FROM PUBLIC, iub_public_runtime;
GRANT EXECUTE ON FUNCTION public.confirm_inventory_batch_with_publication(BIGINT, BIGINT, UUID)
  TO iub_admin_runtime;
