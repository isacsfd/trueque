-- Ninth versioned migration. Manual photographic review for books offered by
-- participants. Additive: drafts, private evidence metadata and review history.
--
-- This migration does NOT accept, catalog, enable or publish any copy. It does
-- not change copies.availability, create inventory_movements or bypass 0007/0008.
-- Physical acceptance continues to use receptions/evaluations/cataloging/admissions.

-- ---------------------------------------------------------------------------
-- 1. Draft / review status and evidence metadata
-- ---------------------------------------------------------------------------

CREATE TABLE public.offered_book_submissions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  access_token_sha256 BYTEA NOT NULL CHECK (octet_length(access_token_sha256) = 32),
  requested_copy_id BIGINT NOT NULL REFERENCES public.copies(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'pending_review', 'in_review', 'needs_information',
    'preapproved', 'rejected'
  )),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 500),
  author TEXT NOT NULL CHECK (length(btrim(author)) BETWEEN 1 AND 500),
  publisher_claim TEXT CHECK (publisher_claim IS NULL OR length(publisher_claim) <= 250),
  genre_claim TEXT CHECK (genre_claim IS NULL OR length(genre_claim) <= 120),
  isbn TEXT,
  isbn_normalized TEXT,
  declared_condition TEXT NOT NULL CHECK (declared_condition IN ('excellent', 'good', 'fair', 'poor')),
  observations TEXT CHECK (observations IS NULL OR length(observations) <= 3000),
  request_id BIGINT UNIQUE REFERENCES public.exchange_requests(id),
  idempotency_key UUID NOT NULL UNIQUE,
  submitted_at TIMESTAMPTZ,
  reviewed_by BIGINT REFERENCES public.app_users(id),
  reviewed_at TIMESTAMPTZ,
  decision_reason TEXT CHECK (decision_reason IS NULL OR length(decision_reason) <= 3000),
  review_notes TEXT CHECK (review_notes IS NULL OR length(review_notes) <= 3000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((isbn IS NULL AND isbn_normalized IS NULL)
      OR (isbn IS NOT NULL AND isbn_normalized IS NOT NULL)),
  CHECK (status = 'draft' OR submitted_at IS NOT NULL),
  CHECK (status = 'draft' OR request_id IS NOT NULL)
);

CREATE INDEX offered_book_submissions_request_idx
  ON public.offered_book_submissions (request_id);
CREATE INDEX offered_book_submissions_status_idx
  ON public.offered_book_submissions (status, created_at);

CREATE TABLE public.offered_book_evidence (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id BIGINT NOT NULL REFERENCES public.offered_book_submissions(id),
  slot TEXT NOT NULL CHECK (slot IN ('cover', 'back_cover', 'spine', 'interior', 'damage')),
  storage_key TEXT NOT NULL UNIQUE CHECK (storage_key ~ '^[A-Za-z0-9._-]{1,120}$'),
  detected_mime TEXT NOT NULL CHECK (detected_mime IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 4194304),
  sha256 BYTEA NOT NULL CHECK (octet_length(sha256) = 32),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 8000),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 8000),
  idempotency_key UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ,
  CHECK (width::BIGINT * height::BIGINT <= 32000000),
  UNIQUE (submission_id, idempotency_key)
);

CREATE INDEX offered_book_evidence_submission_idx
  ON public.offered_book_evidence (submission_id, id)
  WHERE deleted_at IS NULL;

CREATE TABLE public.offered_book_submission_reviews (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id BIGINT NOT NULL REFERENCES public.offered_book_submissions(id),
  actor_user_id BIGINT NOT NULL REFERENCES public.app_users(id),
  action TEXT NOT NULL CHECK (action IN ('start_review', 'request_information', 'preapprove', 'reject')),
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 3000),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 3000),
  idempotency_key UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX offered_book_submission_reviews_submission_idx
  ON public.offered_book_submission_reviews (submission_id, id);

GRANT SELECT ON public.offered_book_submissions, public.offered_book_evidence,
  public.offered_book_submission_reviews TO iub_admin_runtime;
REVOKE ALL ON public.offered_book_submissions, public.offered_book_evidence,
  public.offered_book_submission_reviews FROM PUBLIC, iub_public_runtime;

-- ---------------------------------------------------------------------------
-- 2. Trigger functions for state integrity
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_offered_book_submission_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'draft' AND NEW.status = 'pending_review')
      OR (OLD.status = 'pending_review' AND NEW.status IN ('in_review', 'rejected'))
      OR (OLD.status = 'in_review' AND NEW.status IN ('needs_information', 'preapproved', 'rejected'))
      OR (OLD.status = 'needs_information' AND NEW.status = 'pending_review')
    ) THEN
      RAISE EXCEPTION 'invalid offered-book status transition from % to %',
        OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_offered_book_submission_status()
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;

DROP TRIGGER IF EXISTS offered_book_submissions_set_updated_at
  ON public.offered_book_submissions;
CREATE TRIGGER offered_book_submissions_set_updated_at
  BEFORE UPDATE ON public.offered_book_submissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS offered_book_submissions_status_guard
  ON public.offered_book_submissions;
CREATE TRIGGER offered_book_submissions_status_guard
  BEFORE UPDATE ON public.offered_book_submissions
  FOR EACH ROW EXECUTE FUNCTION public.guard_offered_book_submission_status();

DROP TRIGGER IF EXISTS offered_book_submission_reviews_immutable
  ON public.offered_book_submission_reviews;
CREATE TRIGGER offered_book_submission_reviews_immutable
  BEFORE UPDATE OR DELETE ON public.offered_book_submission_reviews
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();

-- A request cannot be approved while its linked photographic submission is not
-- preapproved. Requests without a submission keep the legacy behaviour.
CREATE OR REPLACE FUNCTION public.guard_request_photo_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF EXISTS (
      SELECT 1 FROM public.offered_book_submissions s WHERE s.request_id = NEW.id
    ) AND NOT EXISTS (
      SELECT 1 FROM public.offered_book_submissions s
      WHERE s.request_id = NEW.id AND s.status = 'preapproved'
    ) THEN
      RAISE EXCEPTION 'the offered-book photographs must be preapproved before request approval'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_request_photo_approval()
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;

DROP TRIGGER IF EXISTS exchange_requests_photo_approval_guard
  ON public.exchange_requests;
CREATE TRIGGER exchange_requests_photo_approval_guard
  BEFORE UPDATE OF status ON public.exchange_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_request_photo_approval();

-- ---------------------------------------------------------------------------
-- 3. Photographic review permission
-- ---------------------------------------------------------------------------

INSERT INTO public.permissions (permission_key, description) VALUES
  ('offered_books.review', 'Revisar fotografias y preaprobar libros ofrecidos')
ON CONFLICT (permission_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Participant draft/evidence functions
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_offered_book_submission(
  p_requested_copy_id BIGINT,
  p_access_hash BYTEA,
  p_title TEXT,
  p_author TEXT,
  p_publisher_claim TEXT,
  p_genre_claim TEXT,
  p_isbn TEXT,
  p_isbn_normalized TEXT,
  p_declared_condition TEXT,
  p_observations TEXT,
  p_idempotency_key UUID
)
RETURNS TABLE (submission_id BIGINT, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_existing public.offered_book_submissions%ROWTYPE;
  v_copy public.copies%ROWTYPE;
  v_id BIGINT;
  v_status TEXT;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '23502';
  END IF;
  IF p_access_hash IS NULL OR octet_length(p_access_hash) <> 32 THEN
    RAISE EXCEPTION 'an access token hash is required' USING ERRCODE = '23514';
  END IF;
  IF p_title IS NULL OR length(btrim(p_title)) < 1 THEN
    RAISE EXCEPTION 'a title is required' USING ERRCODE = '23514';
  END IF;
  IF p_author IS NULL OR length(btrim(p_author)) < 1 THEN
    RAISE EXCEPTION 'an author is required' USING ERRCODE = '23514';
  END IF;
  IF p_declared_condition NOT IN ('excellent', 'good', 'fair', 'poor') THEN
    RAISE EXCEPTION 'invalid declared condition' USING ERRCODE = '23514';
  END IF;
  IF (p_isbn IS NULL) <> (p_isbn_normalized IS NULL) THEN
    RAISE EXCEPTION 'isbn and normalized isbn must be both null or both present' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_existing
  FROM public.offered_book_submissions
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.access_token_sha256 IS DISTINCT FROM p_access_hash
       OR v_existing.requested_copy_id <> p_requested_copy_id THEN
      RAISE EXCEPTION 'draft idempotency key conflict' USING ERRCODE = '23505';
    END IF;
    submission_id := v_existing.id;
    status := v_existing.status;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO v_copy FROM public.copies WHERE id = p_requested_copy_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copy not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.inventory_copy_is_eligible(p_requested_copy_id) THEN
    RAISE EXCEPTION 'copy is not eligible for a new offered-book submission'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.offered_book_submissions
    (access_token_sha256, requested_copy_id, title, author, publisher_claim,
     genre_claim, isbn, isbn_normalized, declared_condition, observations,
     idempotency_key)
  VALUES
    (p_access_hash, p_requested_copy_id, btrim(p_title), btrim(p_author),
     nullif(btrim(p_publisher_claim), ''), nullif(btrim(p_genre_claim), ''),
     nullif(btrim(p_isbn), ''), nullif(btrim(p_isbn_normalized), ''),
     p_declared_condition, nullif(btrim(p_observations), ''), p_idempotency_key)
  RETURNING id, public.offered_book_submissions.status INTO v_id, v_status;

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (NULL, 'offered_book.draft_created', 'offered_book_submission', v_id::TEXT,
     jsonb_build_object('requested_copy_id', p_requested_copy_id, 'status', v_status));

  submission_id := v_id;
  status := v_status;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_offered_book_submission(
  p_submission_id BIGINT,
  p_access_hash BYTEA,
  p_title TEXT,
  p_author TEXT,
  p_publisher_claim TEXT,
  p_genre_claim TEXT,
  p_isbn TEXT,
  p_isbn_normalized TEXT,
  p_declared_condition TEXT,
  p_observations TEXT
)
RETURNS TABLE (submission_id BIGINT, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_sub public.offered_book_submissions%ROWTYPE;
BEGIN
  SELECT * INTO v_sub
  FROM public.offered_book_submissions
  WHERE id = p_submission_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_sub.access_token_sha256 IS DISTINCT FROM p_access_hash THEN
    RAISE EXCEPTION 'invalid submission token' USING ERRCODE = '42501';
  END IF;
  IF v_sub.status NOT IN ('draft', 'needs_information') THEN
    RAISE EXCEPTION 'submission cannot be edited in status %', v_sub.status
      USING ERRCODE = '23514';
  END IF;
  IF p_title IS NULL OR length(btrim(p_title)) < 1
     OR p_author IS NULL OR length(btrim(p_author)) < 1 THEN
    RAISE EXCEPTION 'title and author are required' USING ERRCODE = '23514';
  END IF;
  IF p_declared_condition NOT IN ('excellent', 'good', 'fair', 'poor') THEN
    RAISE EXCEPTION 'invalid declared condition' USING ERRCODE = '23514';
  END IF;
  IF (p_isbn IS NULL) <> (p_isbn_normalized IS NULL) THEN
    RAISE EXCEPTION 'isbn and normalized isbn must be both null or both present' USING ERRCODE = '23514';
  END IF;

  UPDATE public.offered_book_submissions
  SET title = btrim(p_title),
      author = btrim(p_author),
      publisher_claim = nullif(btrim(p_publisher_claim), ''),
      genre_claim = nullif(btrim(p_genre_claim), ''),
      isbn = nullif(btrim(p_isbn), ''),
      isbn_normalized = nullif(btrim(p_isbn_normalized), ''),
      declared_condition = p_declared_condition,
      observations = nullif(btrim(p_observations), '')
  WHERE id = p_submission_id
  RETURNING id, public.offered_book_submissions.status INTO submission_id, status;

  IF v_sub.request_id IS NOT NULL THEN
    UPDATE public.offered_books
    SET title = btrim(p_title),
        author = btrim(p_author),
        publisher_claim = nullif(btrim(p_publisher_claim), ''),
        genre_claim = nullif(btrim(p_genre_claim), ''),
        isbn = nullif(btrim(p_isbn), ''),
        isbn_normalized = nullif(btrim(p_isbn_normalized), ''),
        declared_condition = p_declared_condition,
        observations = nullif(btrim(p_observations), '')
    WHERE request_id = v_sub.request_id;
  END IF;

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (NULL, 'offered_book.draft_updated', 'offered_book_submission', p_submission_id::TEXT,
     jsonb_build_object('status', status));
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.register_offered_book_evidence(
  p_submission_id BIGINT,
  p_access_hash BYTEA,
  p_slot TEXT,
  p_storage_key TEXT,
  p_detected_mime TEXT,
  p_byte_size INTEGER,
  p_sha256 BYTEA,
  p_width INTEGER,
  p_height INTEGER,
  p_idempotency_key UUID
)
RETURNS TABLE (evidence_id BIGINT, storage_key TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_sub public.offered_book_submissions%ROWTYPE;
  v_existing public.offered_book_evidence%ROWTYPE;
  v_active_count INTEGER;
BEGIN
  SELECT * INTO v_sub
  FROM public.offered_book_submissions
  WHERE id = p_submission_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_sub.access_token_sha256 IS DISTINCT FROM p_access_hash THEN
    RAISE EXCEPTION 'invalid submission token' USING ERRCODE = '42501';
  END IF;
  IF v_sub.status NOT IN ('draft', 'needs_information') THEN
    RAISE EXCEPTION 'evidence cannot be changed in status %', v_sub.status
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_existing
  FROM public.offered_book_evidence
  WHERE submission_id = p_submission_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.sha256 IS DISTINCT FROM p_sha256
       OR v_existing.slot IS DISTINCT FROM p_slot THEN
      RAISE EXCEPTION 'evidence idempotency key conflict' USING ERRCODE = '23505';
    END IF;
    evidence_id := v_existing.id;
    storage_key := v_existing.storage_key;
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_slot NOT IN ('cover', 'back_cover', 'spine', 'interior', 'damage') THEN
    RAISE EXCEPTION 'invalid evidence slot' USING ERRCODE = '23514';
  END IF;
  IF p_detected_mime NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
    RAISE EXCEPTION 'unsupported image type' USING ERRCODE = '23514';
  END IF;
  IF p_sha256 IS NULL OR octet_length(p_sha256) <> 32 THEN
    RAISE EXCEPTION 'invalid evidence digest' USING ERRCODE = '23514';
  END IF;
  IF p_byte_size IS NULL OR p_byte_size < 1 OR p_byte_size > 4194304 THEN
    RAISE EXCEPTION 'invalid evidence size' USING ERRCODE = '23514';
  END IF;
  IF p_width IS NULL OR p_height IS NULL OR p_width < 1 OR p_height < 1
     OR p_width > 8000 OR p_height > 8000
     OR p_width::BIGINT * p_height::BIGINT > 32000000 THEN
    RAISE EXCEPTION 'invalid image dimensions' USING ERRCODE = '23514';
  END IF;
  IF p_storage_key IS NULL OR p_storage_key !~ '^[A-Za-z0-9._-]{1,120}$' THEN
    RAISE EXCEPTION 'invalid storage key' USING ERRCODE = '23514';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '23502';
  END IF;

  SELECT count(*) INTO v_active_count
  FROM public.offered_book_evidence
  WHERE submission_id = p_submission_id AND deleted_at IS NULL;
  IF v_active_count >= 12 THEN
    RAISE EXCEPTION 'the maximum number of evidence files has been reached'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.offered_book_evidence
    (submission_id, slot, storage_key, detected_mime, byte_size, sha256,
     width, height, idempotency_key)
  VALUES
    (p_submission_id, p_slot, p_storage_key, p_detected_mime, p_byte_size,
     p_sha256, p_width, p_height, p_idempotency_key)
  RETURNING id, public.offered_book_evidence.storage_key INTO evidence_id, storage_key;

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (NULL, 'offered_book.evidence_uploaded', 'offered_book_submission', p_submission_id::TEXT,
     jsonb_build_object('evidence_id', evidence_id, 'slot', p_slot,
                        'mime', p_detected_mime, 'bytes', p_byte_size));
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_offered_book_evidence(
  p_evidence_id BIGINT,
  p_access_hash BYTEA
)
RETURNS TABLE (storage_key TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_evidence public.offered_book_evidence%ROWTYPE;
  v_sub public.offered_book_submissions%ROWTYPE;
BEGIN
  SELECT * INTO v_evidence FROM public.offered_book_evidence WHERE id = p_evidence_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_sub
  FROM public.offered_book_submissions
  WHERE id = v_evidence.submission_id
  FOR UPDATE;
  IF v_sub.access_token_sha256 IS DISTINCT FROM p_access_hash THEN
    RAISE EXCEPTION 'invalid submission token' USING ERRCODE = '42501';
  END IF;
  IF v_sub.status NOT IN ('draft', 'needs_information') THEN
    RAISE EXCEPTION 'evidence cannot be removed in status %', v_sub.status
      USING ERRCODE = '23514';
  END IF;

  storage_key := v_evidence.storage_key;
  IF v_evidence.deleted_at IS NULL THEN
    UPDATE public.offered_book_evidence
    SET deleted_at = clock_timestamp()
    WHERE id = p_evidence_id;
    INSERT INTO public.audit_events
      (actor_user_id, event_type, resource_type, resource_id, metadata)
    VALUES
      (NULL, 'offered_book.evidence_deleted', 'offered_book_submission',
       v_sub.id::TEXT, jsonb_build_object('evidence_id', p_evidence_id));
  END IF;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.submit_offered_book_submission(
  p_submission_id BIGINT,
  p_access_hash BYTEA,
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
DECLARE
  v_sub public.offered_book_submissions%ROWTYPE;
  v_existing public.exchange_requests%ROWTYPE;
  v_request RECORD;
  v_requested_copy BIGINT;
BEGIN
  IF p_access_hash IS NULL OR octet_length(p_access_hash) <> 32 THEN
    RAISE EXCEPTION 'an access token hash is required' USING ERRCODE = '23514';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_sub
  FROM public.offered_book_submissions
  WHERE id = p_submission_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_sub.access_token_sha256 IS DISTINCT FROM p_access_hash THEN
    RAISE EXCEPTION 'invalid submission token' USING ERRCODE = '42501';
  END IF;
  IF v_sub.status NOT IN ('draft', 'needs_information') THEN
    RAISE EXCEPTION 'submission cannot be submitted in status %', v_sub.status
      USING ERRCODE = '23514';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'the request payload must be an object' USING ERRCODE = '23514';
  END IF;
  v_requested_copy := (p_payload #>> '{request,requestedCopyId}')::BIGINT;
  IF v_requested_copy IS DISTINCT FROM v_sub.requested_copy_id THEN
    RAISE EXCEPTION 'requested copy does not match the draft' USING ERRCODE = '23514';
  END IF;
  IF p_payload #>> '{offeredBook,title}' IS DISTINCT FROM v_sub.title
     OR p_payload #>> '{offeredBook,author}' IS DISTINCT FROM v_sub.author
     OR p_payload #>> '{offeredBook,declaredCondition}' IS DISTINCT FROM v_sub.declared_condition THEN
    RAISE EXCEPTION 'offered-book data does not match the saved draft' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.offered_book_evidence
    WHERE submission_id = p_submission_id AND slot = 'cover' AND deleted_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.offered_book_evidence
    WHERE submission_id = p_submission_id AND slot = 'interior' AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'cover and interior photographs are required before submission'
      USING ERRCODE = '23514';
  END IF;

  IF v_sub.request_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.exchange_requests WHERE id = v_sub.request_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'linked request not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_existing.status NOT IN ('pending', 'under_review') THEN
      RAISE EXCEPTION 'request cannot be resubmitted from status %', v_existing.status
        USING ERRCODE = '23514';
    END IF;
    UPDATE public.offered_book_submissions
    SET status = 'pending_review',
        submitted_at = clock_timestamp(),
        reviewed_by = NULL,
        reviewed_at = NULL,
        decision_reason = NULL,
        review_notes = NULL
    WHERE id = p_submission_id;
    INSERT INTO public.audit_events
      (actor_user_id, event_type, resource_type, resource_id, metadata)
    VALUES
      (NULL, 'offered_book.submitted', 'offered_book_submission', p_submission_id::TEXT,
       jsonb_build_object('request_id', v_existing.id, 'resubmitted', TRUE));
    request_id := v_existing.id;
    request_code := v_existing.request_code;
    participant_id := v_existing.participant_id;
    privacy_consent_id := v_existing.privacy_consent_id;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO v_request
  FROM public.create_exchange_request(p_request_code, p_payload, p_idempotency_key);

  UPDATE public.offered_book_submissions
  SET request_id = v_request.request_id,
      status = 'pending_review',
      submitted_at = clock_timestamp(),
      reviewed_by = NULL,
      reviewed_at = NULL,
      decision_reason = NULL,
      review_notes = NULL
  WHERE id = p_submission_id;

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (NULL, 'offered_book.submitted', 'offered_book_submission', p_submission_id::TEXT,
     jsonb_build_object('request_id', v_request.request_id, 'resubmitted', FALSE));

  request_id := v_request.request_id;
  request_code := v_request.request_code;
  participant_id := v_request.participant_id;
  privacy_consent_id := v_request.privacy_consent_id;
  RETURN NEXT;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Workflow view (photo status + existing physical states)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.offered_book_submission_workflow AS
SELECT
  s.id AS submission_id,
  s.request_id,
  s.status AS photo_status,
  s.title,
  s.author,
  s.declared_condition,
  s.observations,
  s.requested_copy_id,
  s.submitted_at,
  s.reviewed_at,
  s.decision_reason,
  r.request_code,
  r.status AS request_status,
  rec.status AS reception_status,
  ev.outcome AS evaluation_outcome,
  cat.status AS cataloging_status,
  a.status AS admission_status,
  CASE
    WHEN a.status = 'enabled' THEN 'enabled'
    WHEN cat.status = 'authorized' THEN 'cataloged'
    WHEN ev.outcome = 'rejected' OR rec.status = 'rejected' THEN 'not_accepted'
    WHEN ev.outcome = 'accepted' THEN 'accepted'
    WHEN rec.status IN ('received', 'in_custody', 'evaluated') THEN 'received'
    WHEN s.status = 'preapproved'
         AND (r.status IN ('approved', 'scheduled') OR rec.status = 'awaiting_delivery')
      THEN 'pending_physical_delivery'
    ELSE s.status
  END AS workflow_status,
  (SELECT count(*)::int FROM public.offered_book_evidence e
   WHERE e.submission_id = s.id AND e.deleted_at IS NULL) AS evidence_count
FROM public.offered_book_submissions s
LEFT JOIN public.exchange_requests r ON r.id = s.request_id
LEFT JOIN public.exchanges e ON e.request_id = r.id
LEFT JOIN public.receptions rec ON rec.id = e.offered_reception_id
LEFT JOIN public.book_evaluations ev ON ev.reception_id = rec.id AND ev.is_final
LEFT JOIN public.cataloging_records cat ON cat.reception_id = rec.id
LEFT JOIN public.inventory_admissions a ON a.reception_id = rec.id;

GRANT SELECT ON public.offered_book_submission_workflow TO iub_admin_runtime;
REVOKE ALL ON public.offered_book_submission_workflow FROM PUBLIC, iub_public_runtime;

-- ---------------------------------------------------------------------------
-- 6. Participant read functions
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_offered_book_submission(
  p_submission_id BIGINT,
  p_access_hash BYTEA
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'submissionId', s.id::text,
    'status', s.status,
    'workflowStatus', w.workflow_status,
    'requestId', s.request_id::text,
    'requestedCopyId', s.requested_copy_id::text,
    'requestCode', w.request_code,
    'requestStatus', w.request_status,
    'title', s.title,
    'author', s.author,
    'publisher', s.publisher_claim,
    'genre', s.genre_claim,
    'isbn', s.isbn,
    'isbnNormalized', s.isbn_normalized,
    'declaredCondition', s.declared_condition,
    'observations', s.observations,
    'submittedAt', s.submitted_at,
    'reviewedAt', s.reviewed_at,
    'decisionReason', s.decision_reason,
    'reviewNotes', s.review_notes,
    'evidence', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', e.id::text, 'slot', e.slot, 'mime', e.detected_mime,
        'bytes', e.byte_size, 'width', e.width, 'height', e.height,
        'createdAt', e.created_at
      ) ORDER BY e.id)
      FROM public.offered_book_evidence e
      WHERE e.submission_id = s.id AND e.deleted_at IS NULL
    ), '[]'::jsonb)
  )
  FROM public.offered_book_submissions s
  JOIN public.offered_book_submission_workflow w ON w.submission_id = s.id
  WHERE s.id = p_submission_id
    AND s.access_token_sha256 IS NOT DISTINCT FROM p_access_hash;
$function$;

CREATE OR REPLACE FUNCTION public.get_offered_book_evidence(
  p_evidence_id BIGINT,
  p_access_hash BYTEA
)
RETURNS TABLE (
  evidence_id BIGINT,
  storage_key TEXT,
  detected_mime TEXT,
  byte_size INTEGER,
  width INTEGER,
  height INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT e.id, e.storage_key, e.detected_mime, e.byte_size, e.width, e.height
  FROM public.offered_book_evidence e
  JOIN public.offered_book_submissions s ON s.id = e.submission_id
  WHERE e.id = p_evidence_id
    AND e.deleted_at IS NULL
    AND s.access_token_sha256 IS NOT DISTINCT FROM p_access_hash;
$function$;

CREATE OR REPLACE FUNCTION public.resubmit_offered_book_submission(
  p_submission_id BIGINT,
  p_access_hash BYTEA,
  p_idempotency_key UUID
)
RETURNS TABLE (request_id BIGINT, request_code TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_sub public.offered_book_submissions%ROWTYPE;
  v_request public.exchange_requests%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '23502';
  END IF;
  SELECT * INTO v_sub
  FROM public.offered_book_submissions
  WHERE id = p_submission_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_sub.access_token_sha256 IS DISTINCT FROM p_access_hash THEN
    RAISE EXCEPTION 'invalid submission token' USING ERRCODE = '42501';
  END IF;
  IF v_sub.status <> 'needs_information' THEN
    RAISE EXCEPTION 'submission cannot be resubmitted from status %', v_sub.status
      USING ERRCODE = '23514';
  END IF;
  IF v_sub.request_id IS NULL THEN
    RAISE EXCEPTION 'submission has no linked request' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_request FROM public.exchange_requests WHERE id = v_sub.request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'linked request not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_request.status NOT IN ('pending', 'under_review') THEN
    RAISE EXCEPTION 'request cannot be resubmitted from status %', v_request.status
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.offered_book_evidence
    WHERE submission_id = p_submission_id AND slot = 'cover' AND deleted_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.offered_book_evidence
    WHERE submission_id = p_submission_id AND slot = 'interior' AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'cover and interior photographs are required before submission'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.offered_book_submissions
  SET status = 'pending_review',
      submitted_at = clock_timestamp(),
      reviewed_by = NULL,
      reviewed_at = NULL,
      decision_reason = NULL,
      review_notes = NULL
  WHERE id = p_submission_id;

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (NULL, 'offered_book.submitted', 'offered_book_submission', p_submission_id::TEXT,
     jsonb_build_object('request_id', v_request.id, 'resubmitted', TRUE,
                        'idempotency_key', p_idempotency_key));

  request_id := v_request.id;
  request_code := v_request.request_code;
  RETURN NEXT;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Administrative review function
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.review_offered_book_submission(
  p_submission_id BIGINT,
  p_actor_user_id BIGINT,
  p_action TEXT,
  p_reason TEXT,
  p_notes TEXT,
  p_idempotency_key UUID
)
RETURNS TABLE (submission_id BIGINT, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_sub public.offered_book_submissions%ROWTYPE;
  v_review public.offered_book_submission_reviews%ROWTYPE;
  v_new_status TEXT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'offered_books.review');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '23502';
  END IF;
  IF p_action NOT IN ('start_review', 'request_information', 'preapprove', 'reject') THEN
    RAISE EXCEPTION 'invalid review action' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_sub
  FROM public.offered_book_submissions
  WHERE id = p_submission_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_sub.request_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.exchange_requests r
    WHERE r.id = v_sub.request_id
      AND r.status IN ('rejected', 'cancelled', 'completed')
  ) THEN
    RAISE EXCEPTION 'submission request is already closed' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_review
  FROM public.offered_book_submission_reviews
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_review.submission_id <> p_submission_id
       OR v_review.action <> p_action THEN
      RAISE EXCEPTION 'review idempotency key conflict' USING ERRCODE = '23505';
    END IF;
    submission_id := v_sub.id;
    status := v_sub.status;
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_action = 'start_review' THEN
    IF v_sub.status <> 'pending_review' THEN
      RAISE EXCEPTION 'review can only start from pending_review' USING ERRCODE = '23514';
    END IF;
    v_new_status := 'in_review';
  ELSIF p_action = 'request_information' THEN
    IF v_sub.status <> 'in_review' THEN
      RAISE EXCEPTION 'information can only be requested from in_review' USING ERRCODE = '23514';
    END IF;
    IF p_reason IS NULL OR length(btrim(p_reason)) < 1 THEN
      RAISE EXCEPTION 'a reason is required to request information' USING ERRCODE = '23514';
    END IF;
    v_new_status := 'needs_information';
  ELSIF p_action = 'preapprove' THEN
    IF v_sub.status <> 'in_review' THEN
      RAISE EXCEPTION 'preapproval can only happen from in_review' USING ERRCODE = '23514';
    END IF;
    IF p_reason IS NULL OR length(btrim(p_reason)) < 1 THEN
      RAISE EXCEPTION 'a reason is required to preapprove' USING ERRCODE = '23514';
    END IF;
    v_new_status := 'preapproved';
  ELSE
    IF v_sub.status NOT IN ('pending_review', 'in_review') THEN
      RAISE EXCEPTION 'submission cannot be rejected from status %', v_sub.status
        USING ERRCODE = '23514';
    END IF;
    IF p_reason IS NULL OR length(btrim(p_reason)) < 1 THEN
      RAISE EXCEPTION 'a reason is required to reject' USING ERRCODE = '23514';
    END IF;
    v_new_status := 'rejected';
  END IF;

  INSERT INTO public.offered_book_submission_reviews
    (submission_id, actor_user_id, action, previous_status, new_status,
     reason, notes, idempotency_key)
  VALUES
    (p_submission_id, p_actor_user_id, p_action, v_sub.status, v_new_status,
     coalesce(nullif(btrim(p_reason), ''), 'review started'),
     nullif(btrim(p_notes), ''), p_idempotency_key);

  UPDATE public.offered_book_submissions
  SET status = v_new_status,
      reviewed_by = p_actor_user_id,
      reviewed_at = clock_timestamp(),
      decision_reason = btrim(p_reason),
      review_notes = nullif(btrim(p_notes), '')
  WHERE id = p_submission_id
  RETURNING id, public.offered_book_submissions.status INTO submission_id, status;

  INSERT INTO public.audit_events
    (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'offered_book.submission_reviewed', 'offered_book_submission',
     p_submission_id::TEXT,
     jsonb_build_object('action', p_action, 'from', v_sub.status,
                        'to', v_new_status));
  RETURN NEXT;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 8. Grants for reviewed functions
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.create_offered_book_submission(BIGINT, BYTEA, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, UUID)
  FROM PUBLIC, iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.create_offered_book_submission(BIGINT, BYTEA, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, UUID)
  TO iub_public_runtime;

REVOKE ALL ON FUNCTION public.update_offered_book_submission(BIGINT, BYTEA, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.update_offered_book_submission(BIGINT, BYTEA, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
  TO iub_public_runtime;

REVOKE ALL ON FUNCTION public.register_offered_book_evidence(BIGINT, BYTEA, TEXT, TEXT, TEXT, INTEGER, BYTEA, INTEGER, INTEGER, UUID)
  FROM PUBLIC, iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.register_offered_book_evidence(BIGINT, BYTEA, TEXT, TEXT, TEXT, INTEGER, BYTEA, INTEGER, INTEGER, UUID)
  TO iub_public_runtime;

REVOKE ALL ON FUNCTION public.delete_offered_book_evidence(BIGINT, BYTEA)
  FROM PUBLIC, iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.delete_offered_book_evidence(BIGINT, BYTEA)
  TO iub_public_runtime;

REVOKE ALL ON FUNCTION public.submit_offered_book_submission(BIGINT, BYTEA, TEXT, JSONB, UUID)
  FROM PUBLIC, iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.submit_offered_book_submission(BIGINT, BYTEA, TEXT, JSONB, UUID)
  TO iub_public_runtime;

REVOKE ALL ON FUNCTION public.resubmit_offered_book_submission(BIGINT, BYTEA, UUID)
  FROM PUBLIC, iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.resubmit_offered_book_submission(BIGINT, BYTEA, UUID)
  TO iub_public_runtime;

REVOKE ALL ON FUNCTION public.get_offered_book_submission(BIGINT, BYTEA)
  FROM PUBLIC, iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.get_offered_book_submission(BIGINT, BYTEA)
  TO iub_public_runtime;

REVOKE ALL ON FUNCTION public.get_offered_book_evidence(BIGINT, BYTEA)
  FROM PUBLIC, iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.get_offered_book_evidence(BIGINT, BYTEA)
  TO iub_public_runtime;

REVOKE ALL ON FUNCTION public.review_offered_book_submission(BIGINT, BIGINT, TEXT, TEXT, TEXT, UUID)
  FROM PUBLIC, iub_public_runtime;
GRANT EXECUTE ON FUNCTION public.review_offered_book_submission(BIGINT, BIGINT, TEXT, TEXT, TEXT, UUID)
  TO iub_admin_runtime;

-- The physical flow remains in receptions/evaluations/cataloging/admissions.
-- This migration never updates copies, inventory_movements or available_catalog.
