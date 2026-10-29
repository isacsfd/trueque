-- Fifth versioned migration. Additive participant intake and read-only status
-- routines required by the API. 0001-0004 are not edited.

CREATE FUNCTION public.create_exchange_request(
  p_request_code TEXT,
  p_payload JSONB,
  p_idempotency_key UUID
)
RETURNS TABLE (
  request_id BIGINT,
  request_code TEXT,
  participant_id BIGINT,
  privacy_consent_id BIGINT
)
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

  request_id := v_request_id;
  request_code := v_request_code;
  participant_id := v_participant_id;
  privacy_consent_id := v_consent_id;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_exchange_request(TEXT, JSONB, UUID)
  FROM PUBLIC, iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.create_exchange_request(TEXT, JSONB, UUID)
  TO iub_public_runtime;

CREATE FUNCTION public.get_request_status(
  p_request_code TEXT,
  p_access_hash BYTEA
)
RETURNS TABLE (
  request_code TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  copy_title TEXT,
  exchange_status TEXT,
  reception_status TEXT,
  return_required BOOLEAN,
  return_confirmed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    r.request_code,
    r.status,
    r.created_at,
    b.title,
    e.status,
    rec.status,
    coalesce(rec.status IN ('return_pending'), FALSE),
    coalesce(rec.status = 'returned', FALSE)
  FROM public.exchange_requests r
  JOIN public.copies c ON c.id = r.requested_copy_id
  JOIN public.bibliographic_records b ON b.id = c.bibliographic_record_id
  LEFT JOIN public.exchanges e ON e.request_id = r.id
  LEFT JOIN public.receptions rec ON rec.id = e.offered_reception_id
  WHERE r.request_code = p_request_code
    AND r.request_access_token_sha256 IS NOT NULL
    AND r.request_access_token_sha256 IS NOT DISTINCT FROM p_access_hash;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_request_status(TEXT, BYTEA)
  FROM PUBLIC, iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.get_request_status(TEXT, BYTEA)
  TO iub_public_runtime;

CREATE FUNCTION public.prepare_cataloging(
  p_reception_id BIGINT,
  p_title TEXT,
  p_author TEXT,
  p_isbn TEXT,
  p_isbn_normalized TEXT,
  p_actor_user_id BIGINT,
  p_validation_key UUID
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_bibliographic_id BIGINT;
  v_cataloging_id BIGINT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'cataloging.validate');

  IF p_title IS NULL OR p_author IS NULL THEN
    RAISE EXCEPTION 'title and author are required' USING ERRCODE = '23514';
  END IF;
  IF (p_isbn IS NULL) <> (p_isbn_normalized IS NULL) THEN
    RAISE EXCEPTION 'isbn and normalized isbn must be provided together' USING ERRCODE = '23514';
  END IF;

  IF p_isbn_normalized IS NOT NULL THEN
    SELECT id INTO v_bibliographic_id
    FROM public.bibliographic_records
    WHERE isbn_normalized = p_isbn_normalized;
  END IF;

  IF v_bibliographic_id IS NULL THEN
    SELECT id INTO v_bibliographic_id
    FROM public.bibliographic_records
    WHERE lower(title) = lower(p_title)
      AND lower(author) = lower(p_author)
      AND publisher_id IS NULL
      AND edition IS NULL
    ORDER BY id
    LIMIT 1;
  END IF;

  IF v_bibliographic_id IS NULL THEN
    INSERT INTO public.bibliographic_records (title, author, isbn, isbn_normalized)
    VALUES (p_title, p_author, p_isbn, p_isbn_normalized)
    RETURNING id INTO v_bibliographic_id;
  END IF;

  SELECT public.record_cataloging_validation(
    p_reception_id, v_bibliographic_id, p_actor_user_id, p_validation_key
  ) INTO v_cataloging_id;

  RETURN v_cataloging_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.prepare_cataloging(BIGINT, TEXT, TEXT, TEXT, TEXT, BIGINT, UUID)
  FROM PUBLIC, iub_public_runtime;
GRANT EXECUTE ON FUNCTION public.prepare_cataloging(BIGINT, TEXT, TEXT, TEXT, TEXT, BIGINT, UUID)
  TO iub_admin_runtime;
