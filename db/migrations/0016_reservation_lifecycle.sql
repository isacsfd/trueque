-- Sixteenth versioned migration. Atomic catalogue reservation lifecycle.
--
-- Rules:
--   * A request reserves its exact requested copy in the same transaction.
--   * An active reservation is the only hold that can expire.
--   * Approval converts the hold to a terminal commitment and keeps the copy
--     out of the catalogue. Approval never completes the physical exchange.
--   * Rejection/cancellation releases only the hold owned by that request, and
--     restores availability only when no other valid hold exists.
--   * Expiry cancels a pending/under-review request; it never releases an
--     approved/scheduled/in-process hold. Legacy approved holds are converted.

-- ---------------------------------------------------------------------------
-- 1. Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.copy_has_competing_hold(
  p_copy_id BIGINT,
  p_exclude_request_id BIGINT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    EXISTS (
      SELECT 1 FROM public.reservations r
      WHERE r.copy_id = p_copy_id
        AND r.status = 'active'
        AND r.request_id <> coalesce(p_exclude_request_id, 0)
    )
    OR EXISTS (
      SELECT 1 FROM public.exchange_requests q
      WHERE q.requested_copy_id = p_copy_id
        AND q.id <> coalesce(p_exclude_request_id, 0)
        AND q.status IN ('approved', 'scheduled', 'in_process', 'cancellation_pending')
    )
    OR EXISTS (
      SELECT 1 FROM public.exchanges e
      WHERE e.institutional_copy_id = p_copy_id
        AND e.status IN ('planned', 'in_process', 'cancellation_pending')
        AND e.request_id <> coalesce(p_exclude_request_id, 0)
    );
$function$;

CREATE OR REPLACE FUNCTION public.release_reservation_hold(
  p_reservation_id BIGINT,
  p_actor_user_id BIGINT,
  p_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_reservation public.reservations%ROWTYPE;
  v_copy public.copies%ROWTYPE;
  v_request public.exchange_requests%ROWTYPE;
  v_request_id BIGINT;
  v_copy_id BIGINT;
BEGIN
  SELECT request_id, copy_id INTO v_request_id, v_copy_id
  FROM public.reservations
  WHERE id = p_reservation_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Keep the lock order request -> reservation -> copy consistent with the
  -- approval and expiry routines.
  v_request := public.iub_lock_request(v_request_id);

  SELECT * INTO v_reservation
  FROM public.reservations
  WHERE id = p_reservation_id
  FOR UPDATE;

  IF NOT FOUND OR v_reservation.status NOT IN ('active', 'converted') THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO v_copy FROM public.copies WHERE id = v_reservation.copy_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  UPDATE public.reservations
  SET status = 'released', released_at = clock_timestamp()
  WHERE id = v_reservation.id;

  IF v_copy.availability = 'reserved'
     AND NOT public.copy_has_competing_hold(v_copy.id, v_request_id) THEN
    UPDATE public.copies SET availability = 'available' WHERE id = v_copy.id;
    INSERT INTO public.inventory_movements
      (copy_id, movement_type, previous_availability, new_availability, performed_by, reason)
    VALUES
      (v_copy.id, 'reservation_released', 'reserved', 'available', p_actor_user_id,
       left(coalesce(nullif(btrim(p_reason), ''), 'reservation released'), 3000));
  END IF;

  RETURN TRUE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.process_expired_reservation(
  p_reservation_id BIGINT,
  p_actor_user_id BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_reservation public.reservations%ROWTYPE;
  v_request public.exchange_requests%ROWTYPE;
  v_copy public.copies%ROWTYPE;
  v_request_id BIGINT;
  v_copy_id BIGINT;
  v_reason TEXT := 'Reserva vencida sin decisión';
BEGIN
  SELECT request_id, copy_id INTO v_request_id, v_copy_id
  FROM public.reservations
  WHERE id = p_reservation_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  v_request := public.iub_lock_request(v_request_id);

  SELECT * INTO v_reservation
  FROM public.reservations
  WHERE id = p_reservation_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_reservation.status <> 'active'
     OR v_reservation.expires_at > clock_timestamp() THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO v_copy FROM public.copies WHERE id = v_reservation.copy_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- An approved/scheduled/in-process request already owns the copy. A legacy
  -- active hold must become a terminal commitment, never return to catalogue.
  IF v_request.status IN ('approved', 'scheduled', 'in_process') THEN
    UPDATE public.reservations
    SET status = 'converted', released_at = clock_timestamp()
    WHERE id = v_reservation.id;

    IF v_copy.availability = 'available' AND v_request.status IN ('approved', 'scheduled') THEN
      UPDATE public.copies SET availability = 'reserved' WHERE id = v_copy.id;
      INSERT INTO public.inventory_movements
        (copy_id, movement_type, previous_availability, new_availability, performed_by, reason)
      VALUES
        (v_copy.id, 'availability_changed', 'available', 'reserved', p_actor_user_id,
         'legacy approved request hold re-committed');
    ELSIF v_copy.availability = 'reserved' THEN
      INSERT INTO public.inventory_movements
        (copy_id, movement_type, previous_availability, new_availability, performed_by, reason)
      VALUES
        (v_copy.id, 'availability_changed', 'reserved', 'reserved', p_actor_user_id,
         'reservation converted for approved request');
    END IF;

    INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
    VALUES
      (p_actor_user_id, 'reservation.committed_on_expiry', 'reservation', v_reservation.id::TEXT,
       jsonb_build_object('request_id', v_request_id, 'copy_id', v_reservation.copy_id,
                          'request_status', v_request.status));
    RETURN TRUE;
  END IF;

  UPDATE public.reservations
  SET status = 'expired', released_at = clock_timestamp()
  WHERE id = v_reservation.id;

  IF v_copy.availability = 'reserved'
     AND NOT public.copy_has_competing_hold(v_copy.id, v_request_id) THEN
    UPDATE public.copies SET availability = 'available' WHERE id = v_copy.id;
    INSERT INTO public.inventory_movements
      (copy_id, movement_type, previous_availability, new_availability, performed_by, reason)
    VALUES
      (v_copy.id, 'reservation_released', 'reserved', 'available', p_actor_user_id,
       'reservation expired');
  END IF;

  IF v_request.status IN ('pending', 'under_review') THEN
    PERFORM set_config('app.actor_user_id', coalesce(p_actor_user_id, 0)::TEXT, TRUE);
    UPDATE public.exchange_requests SET status = 'cancelled' WHERE id = v_request_id;
    INSERT INTO public.request_status_history
      (request_id, previous_status, new_status, changed_by, reason)
    VALUES
      (v_request_id, v_request.status, 'cancelled', p_actor_user_id, v_reason);
    INSERT INTO public.state_history
      (entity_type, entity_id, previous_state, new_state, changed_by, reason)
    VALUES
      ('exchange_request', v_request_id, v_request.status, 'cancelled', p_actor_user_id, v_reason);
  END IF;

  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'reservation.expired', 'reservation', v_reservation.id::TEXT,
     jsonb_build_object('request_id', v_request_id, 'copy_id', v_reservation.copy_id,
                        'request_status', v_request.status,
                        'request_cancelled', v_request.status IN ('pending', 'under_review')));

  RETURN TRUE;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Atomic reservation
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reserve_copy(
  p_copy_id BIGINT,
  p_request_id BIGINT,
  p_access_hash BYTEA,
  p_idempotency_key UUID
)
RETURNS TABLE (reservation_id BIGINT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request public.exchange_requests%ROWTYPE;
  v_copy public.copies%ROWTYPE;
  v_existing public.reservations%ROWTYPE;
  v_candidate RECORD;
  v_ttl INTEGER;
  v_new_id BIGINT;
  v_expires_at TIMESTAMPTZ;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '23502';
  END IF;

  v_request := public.iub_lock_request(p_request_id);

  IF v_request.request_access_token_sha256 IS NULL
     OR v_request.request_access_token_sha256 IS DISTINCT FROM p_access_hash THEN
    RAISE EXCEPTION 'the request proof is invalid' USING ERRCODE = '42501';
  END IF;

  IF v_request.requested_copy_id <> p_copy_id THEN
    RAISE EXCEPTION 'copy does not match the requested copy' USING ERRCODE = '23514';
  END IF;

  -- Serializes simultaneous attempts for the same physical copy. The unique
  -- partial indexes below remain the final database-level guard.
  PERFORM pg_advisory_xact_lock(hashtextextended('iub:copy-reservation:' || p_copy_id::TEXT, 0));

  SELECT * INTO v_existing
  FROM public.reservations
  WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.copy_id <> p_copy_id OR v_existing.request_id <> p_request_id THEN
      RAISE EXCEPTION 'reservation idempotency key conflict' USING ERRCODE = '23505';
    END IF;
    IF v_existing.status = 'active' AND v_existing.expires_at > clock_timestamp() THEN
      reservation_id := v_existing.id;
      expires_at := v_existing.expires_at;
      RETURN NEXT;
      RETURN;
    END IF;
    IF v_existing.status = 'active' THEN
      PERFORM public.process_expired_reservation(v_existing.id, NULL);
      RAISE EXCEPTION 'the reservation expired' USING ERRCODE = 'P0004';
    END IF;
    IF v_existing.status = 'converted' THEN
      reservation_id := v_existing.id;
      expires_at := v_existing.expires_at;
      RETURN NEXT;
      RETURN;
    END IF;
    RAISE EXCEPTION 'the reservation is no longer active' USING ERRCODE = 'P0004';
  END IF;

  -- A retry from the public form may use a new idempotency key. Return the
  -- existing hold for the same request and exact copy instead of duplicating.
  SELECT * INTO v_existing
  FROM public.reservations
  WHERE request_id = p_request_id AND copy_id = p_copy_id
  ORDER BY id DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'active' AND v_existing.expires_at > clock_timestamp() THEN
      reservation_id := v_existing.id;
      expires_at := v_existing.expires_at;
      RETURN NEXT;
      RETURN;
    END IF;
    IF v_existing.status = 'converted' THEN
      reservation_id := v_existing.id;
      expires_at := v_existing.expires_at;
      RETURN NEXT;
      RETURN;
    END IF;
    IF v_existing.status = 'active' THEN
      PERFORM public.process_expired_reservation(v_existing.id, NULL);
    END IF;
    RAISE EXCEPTION 'the reservation is no longer active' USING ERRCODE = 'P0004';
  END IF;

  IF v_request.status NOT IN ('pending', 'under_review') THEN
    RAISE EXCEPTION 'request is not eligible to reserve a copy' USING ERRCODE = '23514';
  END IF;

  FOR v_candidate IN
    SELECT r.id
    FROM public.reservations r
    WHERE r.copy_id = p_copy_id
      AND r.status = 'active'
      AND r.expires_at <= clock_timestamp()
    ORDER BY r.id
  LOOP
    PERFORM public.process_expired_reservation(v_candidate.id, NULL);
  END LOOP;

  -- process_expired_reservation may have cancelled this request when its own
  -- old hold expired. Re-read the locked request before creating a new hold.
  SELECT * INTO v_request FROM public.exchange_requests WHERE id = p_request_id;
  IF v_request.status NOT IN ('pending', 'under_review') THEN
    RAISE EXCEPTION 'request is no longer eligible to reserve a copy' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_copy FROM public.copies WHERE id = p_copy_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copy not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT duration_seconds INTO v_ttl FROM public.reservation_policy WHERE policy_id = 1;
  IF v_ttl IS NULL THEN
    RAISE EXCEPTION 'the reservation policy is not configured' USING ERRCODE = '55000';
  END IF;

  IF v_copy.availability <> 'available' THEN
    RAISE EXCEPTION 'copy is not available' USING ERRCODE = 'P0005';
  END IF;

  v_expires_at := clock_timestamp() + make_interval(secs => v_ttl);
  INSERT INTO public.reservations (copy_id, request_id, status, idempotency_key, expires_at)
  VALUES (p_copy_id, p_request_id, 'active', p_idempotency_key, v_expires_at)
  RETURNING id INTO v_new_id;

  UPDATE public.copies SET availability = 'reserved' WHERE id = p_copy_id;
  INSERT INTO public.inventory_movements
    (copy_id, movement_type, previous_availability, new_availability, idempotency_key, reason)
  VALUES
    (p_copy_id, 'reserved', 'available', 'reserved', p_idempotency_key, 'temporary exchange reservation');

  reservation_id := v_new_id;
  expires_at := v_expires_at;
  RETURN NEXT;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Expiry: cancel undecided requests, commit approved holds
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.expire_reservations(
  p_actor_user_id BIGINT,
  p_limit INTEGER DEFAULT 100
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_candidate RECORD;
  v_count INTEGER := 0;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'reservations.expire');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  FOR v_candidate IN
    SELECT r.id
    FROM public.reservations r
    WHERE r.status = 'active' AND r.expires_at <= clock_timestamp()
    ORDER BY r.expires_at, r.id
    LIMIT greatest(coalesce(p_limit, 100), 1)
  LOOP
    IF public.process_expired_reservation(v_candidate.id, p_actor_user_id) THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Request creation reserves the exact copy in the same transaction
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_exchange_request(
  p_request_code TEXT,
  p_payload JSONB,
  p_idempotency_key UUID
)
RETURNS TABLE (request_id BIGINT, request_code TEXT, participant_id BIGINT, privacy_consent_id BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
#variable_conflict use_column
DECLARE
  v_full_name_ciphertext BYTEA;
  v_full_name_key_version SMALLINT;
  v_email_ciphertext BYTEA;
  v_email_key_version SMALLINT;
  v_identity_ciphertext BYTEA;
  v_identity_key_version SMALLINT;
  v_identity_fingerprint BYTEA;
  v_hmac_key_version SMALLINT;
  v_notice_version TEXT;
  v_consent_evidence BYTEA;
  v_requested_copy_id BIGINT;
  v_access_hash BYTEA;
  v_offered_title TEXT;
  v_offered_author TEXT;
  v_offered_publisher TEXT;
  v_offered_genre TEXT;
  v_offered_isbn TEXT;
  v_offered_isbn_normalized TEXT;
  v_offered_condition TEXT;
  v_offered_observations TEXT;
  v_participant_id BIGINT;
  v_consent_id BIGINT;
  v_request_id BIGINT;
  v_request_code TEXT;
  v_existing public.exchange_requests%ROWTYPE;
BEGIN
  IF p_request_code IS NULL OR length(trim(p_request_code)) < 8 THEN
    RAISE EXCEPTION 'a request code is required' USING ERRCODE = '23514';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '23502';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'the request payload must be an object' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_existing
  FROM public.exchange_requests
  WHERE idempotency_key = p_idempotency_key::TEXT;
  IF FOUND THEN
    request_id := v_existing.id;
    request_code := v_existing.request_code;
    participant_id := v_existing.participant_id;
    privacy_consent_id := v_existing.privacy_consent_id;

    -- A legacy request created by the previous two-step flow may not have a
    -- hold yet. Repair it on an idempotent retry, but never invent one for a
    -- decided request.
    IF v_existing.status IN ('pending', 'under_review') THEN
      PERFORM public.reserve_copy(
        v_existing.requested_copy_id,
        v_existing.id,
        v_existing.request_access_token_sha256,
        p_idempotency_key
      );
    END IF;
    RETURN NEXT;
    RETURN;
  END IF;

  v_full_name_ciphertext := decode(p_payload #>> '{participant,fullNameCiphertext}', 'hex');
  v_full_name_key_version := (p_payload #>> '{participant,fullNameKeyVersion}')::SMALLINT;
  v_email_ciphertext := decode(p_payload #>> '{participant,emailCiphertext}', 'hex');
  v_email_key_version := (p_payload #>> '{participant,emailKeyVersion}')::SMALLINT;
  v_identity_ciphertext := decode(p_payload #>> '{participant,identityCiphertext}', 'hex');
  v_identity_key_version := (p_payload #>> '{participant,identityKeyVersion}')::SMALLINT;
  v_identity_fingerprint := decode(p_payload #>> '{participant,identityFingerprint}', 'hex');
  v_hmac_key_version := (p_payload #>> '{participant,hmacKeyVersion}')::SMALLINT;
  v_notice_version := p_payload #>> '{consent,noticeVersion}';
  v_consent_evidence := decode(p_payload #>> '{consent,evidenceSha256}', 'hex');
  v_requested_copy_id := (p_payload #>> '{request,requestedCopyId}')::BIGINT;
  v_access_hash := decode(p_payload #>> '{request,accessTokenSha256}', 'hex');
  v_offered_title := p_payload #>> '{offeredBook,title}';
  v_offered_author := p_payload #>> '{offeredBook,author}';
  v_offered_publisher := p_payload #>> '{offeredBook,publisherClaim}';
  v_offered_genre := p_payload #>> '{offeredBook,genreClaim}';
  v_offered_isbn := p_payload #>> '{offeredBook,isbn}';
  v_offered_isbn_normalized := p_payload #>> '{offeredBook,isbnNormalized}';
  v_offered_condition := p_payload #>> '{offeredBook,declaredCondition}';
  v_offered_observations := p_payload #>> '{offeredBook,observations}';

  IF v_full_name_ciphertext IS NULL OR v_email_ciphertext IS NULL
     OR v_identity_ciphertext IS NULL OR v_identity_fingerprint IS NULL
     OR v_full_name_key_version IS NULL OR v_email_key_version IS NULL
     OR v_identity_key_version IS NULL OR v_hmac_key_version IS NULL THEN
    RAISE EXCEPTION 'encrypted participant data is required' USING ERRCODE = '23514';
  END IF;
  IF octet_length(v_identity_fingerprint) <> 32 OR octet_length(v_access_hash) <> 32
     OR octet_length(v_consent_evidence) <> 32 THEN
    RAISE EXCEPTION 'invalid digest length' USING ERRCODE = '23514';
  END IF;
  IF v_notice_version IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.privacy_notices WHERE version = v_notice_version
  ) THEN
    RAISE EXCEPTION 'the privacy notice is not configured' USING ERRCODE = 'P0002';
  END IF;
  IF v_requested_copy_id IS NULL OR v_offered_title IS NULL OR v_offered_author IS NULL
     OR v_offered_condition IS NULL THEN
    RAISE EXCEPTION 'request, copy and offered book data are required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('iub:participant:' || encode(v_identity_fingerprint, 'hex'), 0)
  );

  SELECT pdf.participant_id INTO v_participant_id
  FROM public.participant_document_fingerprints pdf
  WHERE pdf.hmac_key_version = v_hmac_key_version AND pdf.fingerprint = v_identity_fingerprint;

  IF NOT FOUND THEN
    INSERT INTO public.participants
      (full_name_ciphertext, full_name_key_version, email_ciphertext, email_key_version,
       identity_ciphertext, identity_key_version)
    VALUES
      (v_full_name_ciphertext, v_full_name_key_version, v_email_ciphertext, v_email_key_version,
       v_identity_ciphertext, v_identity_key_version)
    RETURNING id INTO v_participant_id;

    INSERT INTO public.participant_document_fingerprints
      (participant_id, hmac_key_version, fingerprint)
    VALUES
      (v_participant_id, v_hmac_key_version, v_identity_fingerprint);
  END IF;

  SELECT id INTO v_consent_id
  FROM public.privacy_consents
  WHERE participant_id = v_participant_id
    AND notice_version = v_notice_version
    AND purpose = 'book_exchange'
    AND withdrawn_at IS NULL;

  IF NOT FOUND THEN
    INSERT INTO public.privacy_consents
      (participant_id, notice_version, purpose, consented_at, evidence_sha256,
       capture_channel, idempotency_key)
    VALUES
      (v_participant_id, v_notice_version, 'book_exchange', clock_timestamp(),
       v_consent_evidence, 'web', md5(p_idempotency_key::TEXT || ':consent')::UUID)
    RETURNING id INTO v_consent_id;
  END IF;

  INSERT INTO public.exchange_requests
    (request_code, participant_id, requested_copy_id, privacy_notice_version, consented_at,
     privacy_consent_id, request_access_token_sha256, idempotency_key)
  VALUES
    (p_request_code, v_participant_id, v_requested_copy_id, v_notice_version, clock_timestamp(),
     v_consent_id, v_access_hash, p_idempotency_key::TEXT)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id, request_code INTO v_request_id, v_request_code;

  IF v_request_id IS NULL THEN
    SELECT * INTO v_existing
    FROM public.exchange_requests
    WHERE idempotency_key = p_idempotency_key::TEXT;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the request could not be created' USING ERRCODE = '23514';
    END IF;
    request_id := v_existing.id;
    request_code := v_existing.request_code;
    participant_id := v_existing.participant_id;
    privacy_consent_id := v_existing.privacy_consent_id;
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.offered_books
    (request_id, title, author, publisher_claim, genre_claim, isbn, isbn_normalized,
     declared_condition, observations)
  VALUES
    (v_request_id, v_offered_title, v_offered_author, v_offered_publisher, v_offered_genre,
     v_offered_isbn, v_offered_isbn_normalized, v_offered_condition, v_offered_observations);

  -- This is the atomic point: if the copy is no longer available, the whole
  -- request, participant and offered-book insert rolls back.
  PERFORM public.reserve_copy(v_requested_copy_id, v_request_id, v_access_hash, p_idempotency_key);

  request_id := v_request_id;
  request_code := v_request_code;
  participant_id := v_participant_id;
  privacy_consent_id := v_consent_id;
  RETURN NEXT;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Approval / rejection / cancellation
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_request_status(
  p_request_id BIGINT,
  p_new_status TEXT,
  p_actor_user_id BIGINT,
  p_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request public.exchange_requests%ROWTYPE;
  v_reservation public.reservations%ROWTYPE;
  v_copy public.copies%ROWTYPE;
  v_requested_copy_id BIGINT;
  v_reason TEXT;
BEGIN
  IF p_new_status = 'cancellation_pending' THEN
    RAISE EXCEPTION 'use cancel_exchange to request a cancellation' USING ERRCODE = '23514';
  END IF;
  IF p_new_status = 'completed' THEN
    RAISE EXCEPTION 'use complete_exchange to complete a request' USING ERRCODE = '23514';
  END IF;
  IF p_new_status = 'rejected'
     AND (p_reason IS NULL OR length(btrim(p_reason)) < 3) THEN
    RAISE EXCEPTION 'a rejection reason is required' USING ERRCODE = '23514';
  END IF;

  PERFORM public.assert_actor_permission(p_actor_user_id, 'requests.review');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  v_request := public.iub_lock_request(p_request_id);

  IF p_new_status = v_request.status THEN
    RETURN;
  END IF;
  IF v_request.status = 'cancellation_pending' THEN
    RAISE EXCEPTION 'use cancel_exchange for a cancellation pending physical return' USING ERRCODE = '23514';
  END IF;
  IF p_new_status IN ('cancelled', 'rejected')
     AND EXISTS (SELECT 1 FROM public.exchanges WHERE request_id = p_request_id) THEN
    RAISE EXCEPTION 'use cancel_exchange for a request with an exchange' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (v_request.status = 'pending' AND p_new_status = 'under_review')
    OR (v_request.status = 'under_review' AND p_new_status IN ('approved', 'rejected'))
    OR (v_request.status = 'approved' AND p_new_status IN ('cancelled', 'rejected'))
    OR (v_request.status = 'scheduled' AND p_new_status IN ('cancelled', 'rejected'))
  ) THEN
    RAISE EXCEPTION 'invalid request status transition from % to %', v_request.status, p_new_status
      USING ERRCODE = '23514';
  END IF;

  v_requested_copy_id := v_request.requested_copy_id;

  IF p_new_status = 'approved' THEN
    SELECT * INTO v_reservation
    FROM public.reservations
    WHERE request_id = p_request_id AND copy_id = v_requested_copy_id
    ORDER BY id DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'the request has no reservation' USING ERRCODE = 'P0004';
    END IF;
    IF v_reservation.status = 'active'
       AND v_reservation.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'the reservation expired before approval' USING ERRCODE = 'P0004';
    END IF;
    IF v_reservation.status NOT IN ('active', 'converted') THEN
      RAISE EXCEPTION 'the reservation is not available for approval' USING ERRCODE = 'P0004';
    END IF;

    SELECT * INTO v_copy FROM public.copies WHERE id = v_reservation.copy_id FOR UPDATE;
    IF NOT FOUND OR v_copy.availability <> 'reserved' THEN
      RAISE EXCEPTION 'the requested copy is not held by this reservation' USING ERRCODE = 'P0004';
    END IF;

    IF v_reservation.status = 'active' THEN
      UPDATE public.reservations
      SET status = 'converted', released_at = clock_timestamp()
      WHERE id = v_reservation.id;
      INSERT INTO public.inventory_movements
        (copy_id, movement_type, previous_availability, new_availability, performed_by, reason)
      VALUES
        (v_copy.id, 'availability_changed', 'reserved', 'reserved', p_actor_user_id,
         'request approved; copy committed');
    END IF;

    INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
    VALUES
      (p_actor_user_id, 'reservation.committed', 'reservation', v_reservation.id::TEXT,
       jsonb_build_object('request_id', p_request_id, 'copy_id', v_copy.id,
                          'inventory_code', v_copy.inventory_code));
  ELSE
    IF p_new_status IN ('rejected', 'cancelled') THEN
      SELECT * INTO v_reservation
      FROM public.reservations
      WHERE request_id = p_request_id AND copy_id = v_requested_copy_id
        AND status IN ('active', 'converted')
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE;

      IF FOUND THEN
        PERFORM public.release_reservation_hold(v_reservation.id, p_actor_user_id, p_reason);
      END IF;
    END IF;
  END IF;

  v_reason := left(coalesce(p_reason, ''), 3000);
  UPDATE public.exchange_requests SET status = p_new_status WHERE id = p_request_id;
  INSERT INTO public.request_status_history
    (request_id, previous_status, new_status, changed_by, reason)
  VALUES
    (p_request_id, v_request.status, p_new_status, p_actor_user_id, v_reason);
  INSERT INTO public.state_history
    (entity_type, entity_id, previous_state, new_state, changed_by, reason)
  VALUES
    ('exchange_request', p_request_id, v_request.status, p_new_status, p_actor_user_id, v_reason);
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'request.status_changed', 'exchange_request', p_request_id::TEXT,
     jsonb_build_object('from', v_request.status, 'to', p_new_status,
                        'reservation_id', v_reservation.id,
                        'copy_id', v_requested_copy_id));
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Planning and starting accept an already committed hold
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.plan_exchange(
  p_request_id BIGINT,
  p_receipt_code TEXT,
  p_planning_key UUID,
  p_actor_user_id BIGINT
)
RETURNS TABLE (exchange_id BIGINT, reception_id BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request public.exchange_requests%ROWTYPE;
  v_existing public.exchanges%ROWTYPE;
  v_reservation public.reservations%ROWTYPE;
  v_copy public.copies%ROWTYPE;
  v_offer_id BIGINT;
  v_new_reception_id BIGINT;
  v_new_exchange_id BIGINT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'exchange.plan');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  v_request := public.iub_lock_request(p_request_id);

  SELECT * INTO v_existing FROM public.exchanges WHERE planning_key = p_planning_key;
  IF FOUND THEN
    IF v_existing.request_id <> p_request_id THEN
      RAISE EXCEPTION 'exchange planning key conflict' USING ERRCODE = '23505';
    END IF;
    exchange_id := v_existing.id;
    reception_id := v_existing.offered_reception_id;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_request.status <> 'approved' THEN
    RAISE EXCEPTION 'only an approved request can be scheduled' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_reservation
  FROM public.reservations
  WHERE request_id = p_request_id AND copy_id = v_request.requested_copy_id
    AND status IN ('active', 'converted')
  ORDER BY id DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND
     OR (v_reservation.status = 'active' AND v_reservation.expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'a valid reservation is required to schedule an exchange' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_copy FROM public.copies WHERE id = v_reservation.copy_id FOR UPDATE;
  IF NOT FOUND OR v_copy.availability <> 'reserved' THEN
    RAISE EXCEPTION 'the reserved copy is not available for scheduling' USING ERRCODE = '23514';
  END IF;

  SELECT id INTO v_offer_id FROM public.offered_books WHERE request_id = p_request_id;
  IF v_offer_id IS NULL THEN
    RAISE EXCEPTION 'request has no offered book' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.receptions WHERE request_id = p_request_id) THEN
    RAISE EXCEPTION 'request already has a reception' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.receptions (request_id, offered_book_id, receipt_code)
  VALUES (p_request_id, v_offer_id, p_receipt_code)
  RETURNING id INTO v_new_reception_id;

  INSERT INTO public.exchanges
    (request_id, institutional_copy_id, offered_reception_id, accepted_reception_id, planning_key, status)
  VALUES
    (p_request_id, v_request.requested_copy_id, v_new_reception_id, v_new_reception_id, p_planning_key, 'planned')
  RETURNING id INTO v_new_exchange_id;

  UPDATE public.exchange_requests SET status = 'scheduled' WHERE id = p_request_id;
  INSERT INTO public.request_status_history
    (request_id, previous_status, new_status, changed_by, reason)
  VALUES
    (p_request_id, 'approved', 'scheduled', p_actor_user_id, 'exchange planned');
  INSERT INTO public.state_history
    (entity_type, entity_id, previous_state, new_state, changed_by, reason)
  VALUES
    ('exchange', v_new_exchange_id, NULL, 'planned', p_actor_user_id, 'exchange planned'),
    ('exchange_request', p_request_id, 'approved', 'scheduled', p_actor_user_id, 'exchange planned');
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'exchange.planned', 'exchange', v_new_exchange_id::TEXT,
     jsonb_build_object('request_id', p_request_id, 'reception_id', v_new_reception_id,
                        'reservation_id', v_reservation.id));

  exchange_id := v_new_exchange_id;
  reception_id := v_new_reception_id;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.start_exchange(
  p_exchange_id BIGINT,
  p_actor_user_id BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request public.exchange_requests%ROWTYPE;
  v_request_id BIGINT;
  v_exchange public.exchanges%ROWTYPE;
  v_reception public.receptions%ROWTYPE;
  v_admission public.inventory_admissions%ROWTYPE;
  v_copy public.copies%ROWTYPE;
  v_institutional public.copies%ROWTYPE;
  v_reservation public.reservations%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'exchange.start');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT request_id INTO v_request_id FROM public.exchanges WHERE id = p_exchange_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exchange not found' USING ERRCODE = 'P0002';
  END IF;

  v_request := public.iub_lock_request(v_request_id);
  SELECT * INTO v_exchange FROM public.exchanges WHERE id = p_exchange_id FOR UPDATE;

  IF v_exchange.status = 'in_process' THEN
    RETURN v_exchange.id;
  END IF;
  IF v_exchange.status <> 'planned' THEN
    RAISE EXCEPTION 'exchange cannot be started' USING ERRCODE = '23514';
  END IF;
  IF v_request.status <> 'scheduled' THEN
    RAISE EXCEPTION 'request must be scheduled' USING ERRCODE = '23514';
  END IF;
  IF v_exchange.offered_reception_id IS NULL THEN
    RAISE EXCEPTION 'the exchange has no offered reception' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_reception FROM public.receptions WHERE id = v_exchange.offered_reception_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offered reception not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_admission
  FROM public.inventory_admissions
  WHERE reception_id = v_exchange.offered_reception_id
  FOR UPDATE;
  IF NOT FOUND OR v_admission.status <> 'enabled' OR v_admission.copy_id IS NULL THEN
    RAISE EXCEPTION 'the offered book must be admitted and enabled before starting' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_copy FROM public.copies WHERE id = v_admission.copy_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offered copy not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_copy.availability <> 'unavailable'
     OR v_copy.provenance_type <> 'exchange_received'
     OR v_copy.source_admission_id IS DISTINCT FROM v_admission.id THEN
    RAISE EXCEPTION 'the offered copy is not ready for exchange completion' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_institutional
  FROM public.copies
  WHERE id = v_exchange.institutional_copy_id
  FOR UPDATE;
  IF NOT FOUND OR v_institutional.availability <> 'reserved' THEN
    RAISE EXCEPTION 'the institutional copy is not reserved' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_reservation
  FROM public.reservations
  WHERE request_id = v_request_id AND copy_id = v_exchange.institutional_copy_id
    AND status IN ('active', 'converted')
  ORDER BY id DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND
     OR (v_reservation.status = 'active' AND v_reservation.expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'a valid reservation is required to start the exchange' USING ERRCODE = '23514';
  END IF;

  IF v_reservation.status = 'active' THEN
    UPDATE public.reservations
    SET status = 'converted', released_at = clock_timestamp()
    WHERE id = v_reservation.id;
  END IF;

  UPDATE public.exchanges
  SET status = 'in_process',
      offered_admission_id = v_admission.id,
      offered_copy_id = v_admission.copy_id
  WHERE id = p_exchange_id;
  UPDATE public.exchange_requests SET status = 'in_process' WHERE id = v_request_id;

  INSERT INTO public.request_status_history
    (request_id, previous_status, new_status, changed_by, reason)
  VALUES
    (v_request_id, 'scheduled', 'in_process', p_actor_user_id, 'exchange started');
  INSERT INTO public.state_history
    (entity_type, entity_id, previous_state, new_state, changed_by, reason)
  VALUES
    ('exchange', p_exchange_id, 'planned', 'in_process', p_actor_user_id, 'exchange started'),
    ('exchange_request', v_request_id, 'scheduled', 'in_process', p_actor_user_id, 'exchange started');
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'exchange.started', 'exchange', p_exchange_id::TEXT,
     jsonb_build_object('request_id', v_request_id, 'reservation_id', v_reservation.id));

  RETURN p_exchange_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Runtime grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.copy_has_competing_hold(BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_reservation_hold(BIGINT, BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_expired_reservation(BIGINT, BIGINT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.copy_has_competing_hold(BIGINT, BIGINT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.release_reservation_hold(BIGINT, BIGINT, TEXT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.process_expired_reservation(BIGINT, BIGINT) TO iub_admin_runtime;
