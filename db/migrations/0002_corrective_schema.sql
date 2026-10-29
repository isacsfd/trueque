-- Additive integrity/security layer over the unchanged 0001 baseline.
-- Do not edit/replay 0001. This migration is transactional and checksum tracked.

DO $baseline_check$
BEGIN
  IF to_regclass('public.exchange_requests') IS NULL
    OR to_regclass('public.copies') IS NULL
    OR to_regclass('public.receptions') IS NULL
    OR to_regclass('public.cataloging_records') IS NULL THEN
    RAISE EXCEPTION 'the original 0001 schema must exist before 0002' USING ERRCODE = '55000';
  END IF;
END;
$baseline_check$;

CREATE TABLE public.schema_object_manifest (
  object_type TEXT NOT NULL,
  object_name TEXT NOT NULL,
  introduced_by TEXT NOT NULL,
  PRIMARY KEY (object_type, object_name)
);

-- OIDC identities are issuer-scoped; legacy subject/email values are retained
-- for controlled migration but are no longer required for new encrypted rows.
ALTER TABLE public.app_users ADD COLUMN identity_issuer TEXT;
ALTER TABLE public.app_users ADD COLUMN email_ciphertext BYTEA;
ALTER TABLE public.app_users ADD COLUMN email_key_version SMALLINT;
ALTER TABLE public.app_users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE public.app_users ALTER COLUMN email_normalized DROP NOT NULL;

DO $remove_subject_only_key$
DECLARE v_constraint RECORD;
BEGIN
  FOR v_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.app_users'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (identity_subject)'
  LOOP
    EXECUTE format('ALTER TABLE public.app_users DROP CONSTRAINT %I', v_constraint.conname);
  END LOOP;
END;
$remove_subject_only_key$;
CREATE UNIQUE INDEX app_users_issuer_subject_uidx
  ON public.app_users (identity_issuer, identity_subject);
ALTER TABLE public.app_users ADD CONSTRAINT app_users_email_cipher_version_ck
  CHECK ((email_ciphertext IS NULL AND email_key_version IS NULL)
      OR (email_ciphertext IS NOT NULL AND email_key_version > 0)) NOT VALID;

ALTER TABLE public.participants ALTER COLUMN full_name DROP NOT NULL;
ALTER TABLE public.participants ALTER COLUMN email DROP NOT NULL;
ALTER TABLE public.participants ALTER COLUMN email_normalized DROP NOT NULL;
ALTER TABLE public.participants ALTER COLUMN identity_fingerprint DROP NOT NULL;
ALTER TABLE public.participants ADD COLUMN full_name_ciphertext BYTEA;
ALTER TABLE public.participants ADD COLUMN full_name_key_version SMALLINT;
ALTER TABLE public.participants ADD COLUMN email_ciphertext BYTEA;
ALTER TABLE public.participants ADD COLUMN email_key_version SMALLINT;
ALTER TABLE public.participants ADD COLUMN identity_key_version SMALLINT;
ALTER TABLE public.participants ADD COLUMN retention_due_at TIMESTAMPTZ;
ALTER TABLE public.participants ADD CONSTRAINT participants_encrypted_contact_versions_ck
  CHECK ((full_name_ciphertext IS NULL AND full_name_key_version IS NULL)
      OR (full_name_ciphertext IS NOT NULL AND full_name_key_version > 0)) NOT VALID;
ALTER TABLE public.participants ADD CONSTRAINT participants_encrypted_email_versions_ck
  CHECK ((email_ciphertext IS NULL AND email_key_version IS NULL)
      OR (email_ciphertext IS NOT NULL AND email_key_version > 0)) NOT VALID;
ALTER TABLE public.participants ADD CONSTRAINT participants_identity_key_version_ck
  CHECK (identity_key_version IS NULL OR identity_key_version > 0) NOT VALID;

CREATE TABLE public.participant_document_fingerprints (
  participant_id BIGINT NOT NULL REFERENCES public.participants(id),
  hmac_key_version SMALLINT NOT NULL CHECK (hmac_key_version > 0),
  fingerprint BYTEA NOT NULL CHECK (octet_length(fingerprint) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (participant_id, hmac_key_version),
  UNIQUE (hmac_key_version, fingerprint)
);

CREATE TABLE public.privacy_notices (
  version TEXT PRIMARY KEY,
  content_sha256 BYTEA NOT NULL CHECK (octet_length(content_sha256) = 32),
  approved_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE public.privacy_consents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  participant_id BIGINT NOT NULL REFERENCES public.participants(id),
  notice_version TEXT NOT NULL REFERENCES public.privacy_notices(version),
  purpose TEXT NOT NULL CHECK (length(trim(purpose)) BETWEEN 1 AND 120),
  consented_at TIMESTAMPTZ NOT NULL,
  evidence_sha256 BYTEA NOT NULL CHECK (octet_length(evidence_sha256) = 32),
  capture_channel TEXT NOT NULL CHECK (capture_channel IN ('web', 'staff_recorded')),
  idempotency_key UUID NOT NULL UNIQUE,
  withdrawn_at TIMESTAMPTZ,
  withdrawal_evidence_sha256 BYTEA CHECK (withdrawal_evidence_sha256 IS NULL OR octet_length(withdrawal_evidence_sha256) = 32),
  withdrawn_by BIGINT REFERENCES public.app_users(id),
  withdrawal_idempotency_key UUID UNIQUE,
  UNIQUE (id, participant_id),
  CHECK ((withdrawn_at IS NULL AND withdrawal_evidence_sha256 IS NULL AND withdrawn_by IS NULL AND withdrawal_idempotency_key IS NULL)
      OR (withdrawn_at IS NOT NULL AND withdrawal_evidence_sha256 IS NOT NULL AND withdrawn_by IS NOT NULL AND withdrawal_idempotency_key IS NOT NULL))
);
CREATE UNIQUE INDEX privacy_consents_one_active_purpose_uidx
  ON public.privacy_consents (participant_id, notice_version, purpose)
  WHERE withdrawn_at IS NULL;
CREATE TABLE public.privacy_consent_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  consent_id BIGINT NOT NULL,
  participant_id BIGINT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('granted', 'withdrawn')),
  evidence_sha256 BYTEA NOT NULL CHECK (octet_length(evidence_sha256) = 32),
  idempotency_key UUID NOT NULL UNIQUE,
  recorded_by BIGINT REFERENCES public.app_users(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (consent_id, event_type),
  FOREIGN KEY (consent_id, participant_id) REFERENCES public.privacy_consents (id, participant_id)
);

-- Consent is tracked through privacy_consents; the legacy notice columns stay
-- for existing rows but are not required for new, consent-linked requests.
ALTER TABLE public.exchange_requests ALTER COLUMN privacy_notice_version DROP NOT NULL;
ALTER TABLE public.exchange_requests ALTER COLUMN consented_at DROP NOT NULL;
ALTER TABLE public.exchange_requests ADD COLUMN privacy_consent_id BIGINT;
ALTER TABLE public.exchange_requests ADD COLUMN request_access_token_sha256 BYTEA;
ALTER TABLE public.exchange_requests ADD CONSTRAINT exchange_requests_consent_participant_fk
  FOREIGN KEY (privacy_consent_id, participant_id) REFERENCES public.privacy_consents (id, participant_id) NOT VALID;
ALTER TABLE public.exchange_requests ADD CONSTRAINT exchange_requests_access_token_ck
  CHECK (request_access_token_sha256 IS NULL OR octet_length(request_access_token_sha256) = 32) NOT VALID;
ALTER TABLE public.exchange_requests ADD CONSTRAINT exchange_requests_id_copy_uq UNIQUE (id, requested_copy_id);
ALTER TABLE public.exchange_requests ADD CONSTRAINT exchange_requests_id_participant_uq UNIQUE (id, participant_id);
CREATE UNIQUE INDEX exchange_requests_one_open_per_participant_copy_uidx
  ON public.exchange_requests (participant_id, requested_copy_id)
  WHERE status IN ('pending', 'under_review', 'approved', 'scheduled', 'in_process');

-- The old no-ISBN unique index can reject distinct editions/formats. Keep the
-- ISBN key and use cataloguing review for books without ISBN.
DROP INDEX public.bibliographic_records_without_isbn_uidx;

ALTER TABLE public.offered_books ADD CONSTRAINT offered_books_id_request_uq UNIQUE (id, request_id);
ALTER TABLE public.receptions ADD CONSTRAINT receptions_id_request_uq UNIQUE (id, request_id);
ALTER TABLE public.receptions ADD CONSTRAINT receptions_offer_same_request_fk
  FOREIGN KEY (offered_book_id, request_id) REFERENCES public.offered_books (id, request_id);

ALTER TABLE public.book_evaluations ADD COLUMN is_final BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.book_evaluations ADD COLUMN idempotency_key UUID;
ALTER TABLE public.book_evaluations ADD COLUMN evidence_reference TEXT;
ALTER TABLE public.book_evaluations ADD CONSTRAINT book_evaluations_id_reception_uq UNIQUE (id, reception_id);
CREATE UNIQUE INDEX book_evaluations_idempotency_uidx ON public.book_evaluations (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX book_evaluations_one_final_per_reception_uidx ON public.book_evaluations (reception_id) WHERE is_final;

ALTER TABLE public.cataloging_records ADD COLUMN validation_key UUID;
ALTER TABLE public.cataloging_records ADD COLUMN authorization_key UUID;
ALTER TABLE public.cataloging_records ADD CONSTRAINT cataloging_id_reception_uq UNIQUE (id, reception_id);
CREATE UNIQUE INDEX cataloging_validation_key_uidx ON public.cataloging_records (validation_key) WHERE validation_key IS NOT NULL;
CREATE UNIQUE INDEX cataloging_authorization_key_uidx ON public.cataloging_records (authorization_key) WHERE authorization_key IS NOT NULL;

DO $remove_copy_before_authorization$
DECLARE v_constraint RECORD;
BEGIN
  FOR v_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.cataloging_records'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%copy_id IS NOT NULL%'
  LOOP
    EXECUTE format('ALTER TABLE public.cataloging_records DROP CONSTRAINT %I', v_constraint.conname);
  END LOOP;
END;
$remove_copy_before_authorization$;
ALTER TABLE public.cataloging_records ADD CONSTRAINT cataloging_authorization_metadata_ck
  CHECK (status <> 'authorized' OR
    (bibliographic_record_id IS NOT NULL AND validated_by IS NOT NULL AND validated_at IS NOT NULL
     AND authorized_by IS NOT NULL AND authorized_at IS NOT NULL AND validated_by <> authorized_by)) NOT VALID;

CREATE TABLE public.ownership_transfers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reception_id BIGINT NOT NULL UNIQUE REFERENCES public.receptions(id),
  request_id BIGINT NOT NULL,
  participant_id BIGINT NOT NULL REFERENCES public.participants(id),
  transferor_type TEXT NOT NULL CHECK (transferor_type = 'participant'),
  transferee_type TEXT NOT NULL CHECK (transferee_type = 'institution'),
  accepted_by BIGINT NOT NULL REFERENCES public.app_users(id),
  evidence_reference TEXT NOT NULL CHECK (length(trim(evidence_reference)) BETWEEN 1 AND 500),
  idempotency_key UUID NOT NULL UNIQUE,
  transferred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, reception_id),
  FOREIGN KEY (reception_id, request_id) REFERENCES public.receptions (id, request_id),
  FOREIGN KEY (request_id, participant_id) REFERENCES public.exchange_requests (id, participant_id)
);
CREATE TABLE public.inventory_admissions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reception_id BIGINT NOT NULL UNIQUE REFERENCES public.receptions(id),
  evaluation_id BIGINT NOT NULL UNIQUE,
  cataloging_record_id BIGINT NOT NULL UNIQUE,
  ownership_transfer_id BIGINT NOT NULL UNIQUE,
  copy_id BIGINT UNIQUE REFERENCES public.copies(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'authorized', 'admitted', 'enabled', 'rejected')),
  authorized_by BIGINT REFERENCES public.app_users(id),
  authorized_at TIMESTAMPTZ,
  admitted_by BIGINT REFERENCES public.app_users(id),
  admitted_at TIMESTAMPTZ,
  enabled_by BIGINT REFERENCES public.app_users(id),
  enabled_at TIMESTAMPTZ,
  idempotency_key UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, reception_id),
  CHECK (status NOT IN ('authorized', 'admitted', 'enabled') OR (authorized_by IS NOT NULL AND authorized_at IS NOT NULL)),
  CHECK (status NOT IN ('admitted', 'enabled') OR (admitted_by IS NOT NULL AND admitted_at IS NOT NULL)),
  CHECK (status <> 'enabled' OR (enabled_by IS NOT NULL AND enabled_at IS NOT NULL)),
  FOREIGN KEY (evaluation_id, reception_id) REFERENCES public.book_evaluations (id, reception_id),
  FOREIGN KEY (cataloging_record_id, reception_id) REFERENCES public.cataloging_records (id, reception_id),
  FOREIGN KEY (ownership_transfer_id, reception_id) REFERENCES public.ownership_transfers (id, reception_id)
);
ALTER TABLE public.copies ADD COLUMN source_admission_id BIGINT;
ALTER TABLE public.copies ADD COLUMN ownership_acquired_at TIMESTAMPTZ;
ALTER TABLE public.copies ADD CONSTRAINT copies_source_admission_fk FOREIGN KEY (source_admission_id) REFERENCES public.inventory_admissions(id);
ALTER TABLE public.copies ADD CONSTRAINT copies_source_admission_uq UNIQUE (source_admission_id);
ALTER TABLE public.copies ADD CONSTRAINT copies_source_pair_uq UNIQUE (id, source_admission_id);
ALTER TABLE public.inventory_admissions ADD CONSTRAINT inventory_admission_copy_pair_fk
  FOREIGN KEY (copy_id, id) REFERENCES public.copies (id, source_admission_id);

DO $replace_copy_provenance_check$
DECLARE v_constraint RECORD;
BEGIN
  FOR v_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.copies'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%provenance_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.copies DROP CONSTRAINT %I', v_constraint.conname);
  END LOOP;
END;
$replace_copy_provenance_check$;
ALTER TABLE public.copies ADD CONSTRAINT copies_provenance_type_check
  CHECK (provenance_type IN ('institutional', 'donation', 'purchase', 'other', 'preexisting', 'exchange_received')) NOT VALID;
ALTER TABLE public.copies ADD CONSTRAINT copies_exchange_source_check
  CHECK ((provenance_type = 'exchange_received' AND source_admission_id IS NOT NULL AND ownership_acquired_at IS NOT NULL)
      OR (provenance_type <> 'exchange_received' AND source_admission_id IS NULL)) NOT VALID;

ALTER TABLE public.reservations ADD COLUMN idempotency_key UUID;
CREATE UNIQUE INDEX reservations_idempotency_uidx ON public.reservations (idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE public.reservations ADD CONSTRAINT reservations_release_state_ck
  CHECK ((status = 'active' AND released_at IS NULL) OR (status <> 'active' AND released_at IS NOT NULL)) NOT VALID;
CREATE TABLE public.reservation_policy (
  policy_id SMALLINT PRIMARY KEY CHECK (policy_id = 1),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
  updated_by BIGINT NOT NULL REFERENCES public.app_users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.exchanges ADD COLUMN planning_key UUID;
ALTER TABLE public.exchanges ADD COLUMN offered_admission_id BIGINT;
ALTER TABLE public.exchanges ADD COLUMN completion_idempotency_key UUID;
ALTER TABLE public.exchanges ADD COLUMN cancellation_idempotency_key UUID;
ALTER TABLE public.exchanges ADD COLUMN cancelled_at TIMESTAMPTZ;
CREATE UNIQUE INDEX exchanges_planning_key_uidx ON public.exchanges (planning_key) WHERE planning_key IS NOT NULL;
CREATE UNIQUE INDEX exchanges_completion_key_uidx ON public.exchanges (completion_idempotency_key) WHERE completion_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX exchanges_cancellation_key_uidx ON public.exchanges (cancellation_idempotency_key) WHERE cancellation_idempotency_key IS NOT NULL;
ALTER TABLE public.exchanges ADD CONSTRAINT exchanges_id_request_uq UNIQUE (id, request_id);
ALTER TABLE public.exchanges ADD CONSTRAINT exchanges_request_target_fk
  FOREIGN KEY (request_id, institutional_copy_id) REFERENCES public.exchange_requests (id, requested_copy_id);
ALTER TABLE public.exchanges ADD CONSTRAINT exchanges_reception_request_fk
  FOREIGN KEY (accepted_reception_id, request_id) REFERENCES public.receptions (id, request_id) NOT VALID;
ALTER TABLE public.exchanges ADD CONSTRAINT exchanges_admission_reception_fk
  FOREIGN KEY (offered_admission_id, accepted_reception_id) REFERENCES public.inventory_admissions (id, reception_id) NOT VALID;
ALTER TABLE public.exchanges ADD CONSTRAINT exchanges_offered_copy_admission_fk
  FOREIGN KEY (offered_copy_id, offered_admission_id) REFERENCES public.copies (id, source_admission_id) NOT VALID;

ALTER TABLE public.exchanges ADD COLUMN offered_reception_id BIGINT;
ALTER TABLE public.exchanges ADD CONSTRAINT exchanges_offered_reception_request_fk
  FOREIGN KEY (offered_reception_id, request_id) REFERENCES public.receptions (id, request_id) NOT VALID;

CREATE TABLE public.state_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('exchange', 'exchange_request', 'reception', 'delivery')),
  entity_id BIGINT NOT NULL,
  previous_state TEXT,
  new_state TEXT NOT NULL,
  changed_by BIGINT REFERENCES public.app_users(id),
  reason TEXT CHECK (length(reason) <= 3000),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX state_history_entity_time_idx
  ON public.state_history (entity_type, entity_id, changed_at DESC);

CREATE TABLE public.reception_custody_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reception_id BIGINT NOT NULL REFERENCES public.receptions(id),
  location TEXT NOT NULL CHECK (length(trim(location)) BETWEEN 1 AND 200),
  custodian TEXT NOT NULL CHECK (length(trim(custodian)) BETWEEN 1 AND 200),
  evidence_reference TEXT NOT NULL CHECK (length(trim(evidence_reference)) BETWEEN 1 AND 500),
  idempotency_key UUID NOT NULL UNIQUE,
  recorded_by BIGINT NOT NULL REFERENCES public.app_users(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.deliveries ADD COLUMN exchange_id BIGINT;
ALTER TABLE public.deliveries ADD COLUMN idempotency_key UUID;
ALTER TABLE public.deliveries ADD COLUMN completed_by BIGINT REFERENCES public.app_users(id);
ALTER TABLE public.deliveries ADD CONSTRAINT deliveries_exchange_request_fk
  FOREIGN KEY (exchange_id, request_id) REFERENCES public.exchanges (id, request_id) NOT VALID;
ALTER TABLE public.deliveries ADD CONSTRAINT deliveries_reception_request_fk
  FOREIGN KEY (reception_id, request_id) REFERENCES public.receptions (id, request_id) NOT VALID;
CREATE UNIQUE INDEX deliveries_idempotency_uidx ON public.deliveries (idempotency_key) WHERE idempotency_key IS NOT NULL;
DO $delivery_status_check$
DECLARE v_constraint RECORD;
BEGIN
  FOR v_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.deliveries'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%missed%'
  LOOP
    EXECUTE format('ALTER TABLE public.deliveries DROP CONSTRAINT %I', v_constraint.conname);
  END LOOP;
END;
$delivery_status_check$;
ALTER TABLE public.deliveries ADD CONSTRAINT deliveries_status_check
  CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled', 'missed')) NOT VALID;
CREATE UNIQUE INDEX deliveries_one_open_type_per_exchange_uidx
  ON public.deliveries (exchange_id, delivery_type)
  WHERE exchange_id IS NOT NULL AND status IN ('scheduled', 'in_progress');
CREATE UNIQUE INDEX deliveries_one_completed_type_per_exchange_uidx
  ON public.deliveries (exchange_id, delivery_type)
  WHERE exchange_id IS NOT NULL AND status = 'completed';
CREATE INDEX deliveries_reception_idx ON public.deliveries (reception_id, status);

ALTER TABLE public.inventory_movements ADD COLUMN idempotency_key UUID;
CREATE UNIQUE INDEX inventory_movements_idempotency_uidx
  ON public.inventory_movements (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX inventory_movements_exchange_copy_type_uidx
  ON public.inventory_movements (exchange_id, copy_id, movement_type) WHERE exchange_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Integrity helpers and append-only guards
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.assert_actor_permission(p_actor_user_id BIGINT, p_permission_key TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'an actor is required' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_users u WHERE u.id = p_actor_user_id AND u.is_active) THEN
    RAISE EXCEPTION 'the actor is not an active user' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = p_actor_user_id AND p.permission_key = p_permission_key
  ) THEN
    RAISE EXCEPTION 'the actor lacks permission %', p_permission_key USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.reject_immutable_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$function$;

CREATE FUNCTION public.require_routine_for_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND coalesce(current_setting('app.actor_user_id', TRUE), '') = '' THEN
    RAISE EXCEPTION '% status changes must use a database routine', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.record_consent_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.privacy_consent_events
      (consent_id, participant_id, event_type, evidence_sha256, idempotency_key, recorded_by, occurred_at)
    VALUES
      (NEW.id, NEW.participant_id, 'granted', NEW.evidence_sha256,
       md5(NEW.idempotency_key::TEXT || ':granted')::UUID, NULL, NEW.consented_at);
    RETURN NEW;
  END IF;
  IF NEW.withdrawn_at IS NOT NULL AND OLD.withdrawn_at IS NULL THEN
    INSERT INTO public.privacy_consent_events
      (consent_id, participant_id, event_type, evidence_sha256, idempotency_key, recorded_by, occurred_at)
    VALUES
      (NEW.id, NEW.participant_id, 'withdrawn', NEW.withdrawal_evidence_sha256,
       md5(NEW.withdrawal_idempotency_key::TEXT || ':withdrawn')::UUID, NEW.withdrawn_by, NEW.withdrawn_at);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.guard_exchange_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.privacy_consent_id IS NULL THEN
      RAISE EXCEPTION 'an active consent is required to open a request' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.privacy_consents c
      WHERE c.id = NEW.privacy_consent_id
        AND c.participant_id = NEW.participant_id
        AND c.withdrawn_at IS NULL
    ) THEN
      RAISE EXCEPTION 'an active consent is required to open a request' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND coalesce(current_setting('app.actor_user_id', TRUE), '') = '' THEN
    RAISE EXCEPTION 'request status changes must use a database routine' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER app_users_set_updated_at BEFORE UPDATE ON public.app_users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER participants_set_updated_at BEFORE UPDATE ON public.participants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER bibliographic_records_set_updated_at BEFORE UPDATE ON public.bibliographic_records
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER copies_set_updated_at BEFORE UPDATE ON public.copies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER exchange_requests_set_updated_at BEFORE UPDATE ON public.exchange_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER receptions_set_updated_at BEFORE UPDATE ON public.receptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER cataloging_records_set_updated_at BEFORE UPDATE ON public.cataloging_records
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER exchanges_set_updated_at BEFORE UPDATE ON public.exchanges
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER exchange_requests_guard
  BEFORE INSERT OR UPDATE ON public.exchange_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_exchange_request();
CREATE TRIGGER exchanges_status_routine_only
  BEFORE UPDATE ON public.exchanges
  FOR EACH ROW EXECUTE FUNCTION public.require_routine_for_status_change();
CREATE TRIGGER receptions_status_routine_only
  BEFORE UPDATE ON public.receptions
  FOR EACH ROW EXECUTE FUNCTION public.require_routine_for_status_change();
CREATE TRIGGER deliveries_status_routine_only
  BEFORE UPDATE ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public.require_routine_for_status_change();

CREATE TRIGGER privacy_consents_record_event
  AFTER INSERT OR UPDATE ON public.privacy_consents
  FOR EACH ROW EXECUTE FUNCTION public.record_consent_event();

CREATE TRIGGER request_status_history_immutable
  BEFORE UPDATE OR DELETE ON public.request_status_history
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
CREATE TRIGGER reception_status_history_immutable
  BEFORE UPDATE OR DELETE ON public.reception_status_history
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
CREATE TRIGGER state_history_immutable
  BEFORE UPDATE OR DELETE ON public.state_history
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
CREATE TRIGGER privacy_consent_events_immutable
  BEFORE UPDATE OR DELETE ON public.privacy_consent_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
CREATE TRIGGER participant_document_fingerprints_immutable
  BEFORE UPDATE OR DELETE ON public.participant_document_fingerprints
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
CREATE TRIGGER book_evaluations_immutable
  BEFORE UPDATE OR DELETE ON public.book_evaluations
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
CREATE TRIGGER ownership_transfers_immutable
  BEFORE UPDATE OR DELETE ON public.ownership_transfers
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
CREATE TRIGGER reception_custody_events_immutable
  BEFORE UPDATE OR DELETE ON public.reception_custody_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
CREATE TRIGGER inventory_movements_immutable
  BEFORE UPDATE OR DELETE ON public.inventory_movements
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();

-- ---------------------------------------------------------------------------
-- Atomic business routines
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.reserve_copy(
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
  v_ttl INTEGER;
  v_new_id BIGINT;
  v_expires_at TIMESTAMPTZ;
  v_expired RECORD;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_existing FROM public.reservations r WHERE r.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.copy_id <> p_copy_id OR v_existing.request_id <> p_request_id THEN
      RAISE EXCEPTION 'reservation idempotency key conflict' USING ERRCODE = '23505';
    END IF;
    reservation_id := v_existing.id;
    expires_at := v_existing.expires_at;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO v_request FROM public.exchange_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_request.request_access_token_sha256 IS NULL
     OR v_request.request_access_token_sha256 <> p_access_hash THEN
    RAISE EXCEPTION 'the request proof is invalid' USING ERRCODE = '42501';
  END IF;
  IF v_request.status NOT IN ('pending', 'under_review', 'approved', 'scheduled') THEN
    RAISE EXCEPTION 'request is not eligible to reserve a copy' USING ERRCODE = '23514';
  END IF;
  IF v_request.requested_copy_id <> p_copy_id THEN
    RAISE EXCEPTION 'copy does not match the requested copy' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_copy FROM public.copies WHERE id = p_copy_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copy not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT duration_seconds INTO v_ttl FROM public.reservation_policy WHERE policy_id = 1;
  IF v_ttl IS NULL THEN
    RAISE EXCEPTION 'the reservation policy is not configured' USING ERRCODE = '55000';
  END IF;

  FOR v_expired IN
    UPDATE public.reservations r
    SET status = 'expired', released_at = clock_timestamp()
    WHERE r.copy_id = p_copy_id AND r.status = 'active' AND r.expires_at <= clock_timestamp()
    RETURNING r.id, r.copy_id
  LOOP
    INSERT INTO public.inventory_movements
      (copy_id, movement_type, previous_availability, new_availability, reason)
    VALUES
      (v_expired.copy_id, 'reservation_released', 'reserved', 'available', 'reservation expired');
    UPDATE public.copies SET availability = 'available' WHERE id = v_expired.copy_id;
  END LOOP;

  SELECT * INTO v_copy FROM public.copies WHERE id = p_copy_id FOR UPDATE;
  IF v_copy.availability <> 'available' THEN
    RAISE EXCEPTION 'copy is not available' USING ERRCODE = '23514';
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

CREATE FUNCTION public.set_reservation_policy(p_duration_seconds INTEGER, p_actor_user_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'reservations.configure');
  IF p_duration_seconds IS NULL OR p_duration_seconds <= 0 THEN
    RAISE EXCEPTION 'reservation duration must be positive' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.reservation_policy (policy_id, duration_seconds, updated_by, updated_at)
  VALUES (1, p_duration_seconds, p_actor_user_id, clock_timestamp())
  ON CONFLICT (policy_id) DO UPDATE
    SET duration_seconds = EXCLUDED.duration_seconds,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;
END;
$function$;

CREATE FUNCTION public.expire_reservations(p_actor_user_id BIGINT, p_limit INTEGER DEFAULT 100)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_count INTEGER := 0;
  v_reservation RECORD;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'reservations.expire');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  FOR v_reservation IN
    SELECT r.id, r.copy_id
    FROM public.reservations r
    WHERE r.status = 'active' AND r.expires_at <= clock_timestamp()
    ORDER BY r.expires_at
    LIMIT greatest(coalesce(p_limit, 100), 1)
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.reservations
    SET status = 'expired', released_at = clock_timestamp()
    WHERE id = v_reservation.id;
    UPDATE public.copies
    SET availability = 'available'
    WHERE id = v_reservation.copy_id AND availability = 'reserved';
    INSERT INTO public.inventory_movements
      (copy_id, movement_type, previous_availability, new_availability, idempotency_key, reason)
    VALUES
      (v_reservation.copy_id, 'reservation_released', 'reserved', 'available',
       md5('expire:' || v_reservation.id::TEXT)::UUID, 'reservation expired');
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

CREATE FUNCTION public.set_request_status(
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
  v_exchange public.exchanges%ROWTYPE;
  v_reservation public.reservations%ROWTYPE;
BEGIN
  IF p_new_status = 'completed' THEN
    RAISE EXCEPTION 'use complete_exchange to complete a request' USING ERRCODE = '23514';
  END IF;
  PERFORM public.assert_actor_permission(p_actor_user_id, 'requests.review');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT * INTO v_request FROM public.exchange_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_new_status = v_request.status THEN
    RETURN;
  END IF;
  IF v_request.status = 'in_process' THEN
    RAISE EXCEPTION 'use cancel_exchange for an in-process exchange' USING ERRCODE = '23514';
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

  IF p_new_status IN ('cancelled', 'rejected') THEN
    FOR v_exchange IN
      SELECT * FROM public.exchanges WHERE request_id = p_request_id AND status = 'planned' FOR UPDATE
    LOOP
      UPDATE public.exchanges
      SET status = 'cancelled',
          cancellation_idempotency_key = md5('request-cancel:' || v_exchange.id::TEXT)::UUID,
          cancelled_at = clock_timestamp()
      WHERE id = v_exchange.id;
      INSERT INTO public.state_history
        (entity_type, entity_id, previous_state, new_state, changed_by, reason)
      VALUES
        ('exchange', v_exchange.id, 'planned', 'cancelled', p_actor_user_id, left(coalesce(p_reason, ''), 3000));
    END LOOP;

    SELECT * INTO v_reservation
    FROM public.reservations
    WHERE request_id = p_request_id AND status = 'active'
    FOR UPDATE;
    IF FOUND THEN
      UPDATE public.reservations
      SET status = 'released', released_at = clock_timestamp()
      WHERE id = v_reservation.id;
      UPDATE public.copies
      SET availability = 'available'
      WHERE id = v_reservation.copy_id AND availability = 'reserved';
      INSERT INTO public.inventory_movements
        (copy_id, movement_type, previous_availability, new_availability, reason)
      VALUES
        (v_reservation.copy_id, 'reservation_released', 'reserved', 'available', 'request cancelled');
    END IF;
  END IF;

  UPDATE public.exchange_requests SET status = p_new_status WHERE id = p_request_id;
  INSERT INTO public.request_status_history
    (request_id, previous_status, new_status, changed_by, reason)
  VALUES
    (p_request_id, v_request.status, p_new_status, p_actor_user_id, left(coalesce(p_reason, ''), 3000));
  INSERT INTO public.state_history
    (entity_type, entity_id, previous_state, new_state, changed_by, reason)
  VALUES
    ('exchange_request', p_request_id, v_request.status, p_new_status, p_actor_user_id, left(coalesce(p_reason, ''), 3000));
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'request.status_changed', 'exchange_request', p_request_id::TEXT,
     jsonb_build_object('from', v_request.status, 'to', p_new_status));
END;
$function$;

CREATE FUNCTION public.plan_exchange(
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
  v_offer_id BIGINT;
  v_new_reception_id BIGINT;
  v_new_exchange_id BIGINT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'exchange.plan');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT * INTO v_request FROM public.exchange_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request not found' USING ERRCODE = 'P0002';
  END IF;

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
  IF NOT EXISTS (
    SELECT 1 FROM public.reservations r
    WHERE r.request_id = p_request_id AND r.copy_id = v_request.requested_copy_id
      AND r.status = 'active' AND r.expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'an active reservation is required to schedule an exchange' USING ERRCODE = '23514';
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
     jsonb_build_object('request_id', p_request_id, 'reception_id', v_new_reception_id));

  exchange_id := v_new_exchange_id;
  reception_id := v_new_reception_id;
  RETURN NEXT;
END;
$function$;

CREATE FUNCTION public.schedule_delivery(
  p_exchange_id BIGINT,
  p_delivery_type TEXT,
  p_scheduled_at TIMESTAMPTZ,
  p_idempotency_key UUID,
  p_actor_user_id BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request_id BIGINT;
  v_exchange public.exchanges%ROWTYPE;
  v_reception public.receptions%ROWTYPE;
  v_existing public.deliveries%ROWTYPE;
  v_delivery_id BIGINT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'delivery.schedule');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT request_id INTO v_request_id FROM public.exchanges WHERE id = p_exchange_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exchange not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.exchange_requests WHERE id = v_request_id FOR UPDATE;
  SELECT * INTO v_exchange FROM public.exchanges WHERE id = p_exchange_id FOR UPDATE;

  SELECT * INTO v_existing FROM public.deliveries WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.exchange_id <> p_exchange_id OR v_existing.delivery_type <> p_delivery_type THEN
      RAISE EXCEPTION 'delivery idempotency key conflict' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.id;
  END IF;

  IF p_delivery_type NOT IN ('offered_book_dropoff', 'offered_book_return', 'institutional_copy_handover') THEN
    RAISE EXCEPTION 'unknown delivery type' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_reception FROM public.receptions WHERE request_id = v_request_id FOR UPDATE;

  IF p_delivery_type = 'offered_book_dropoff' THEN
    IF v_exchange.status <> 'planned' THEN
      RAISE EXCEPTION 'a dropoff can only be scheduled for a planned exchange' USING ERRCODE = '23514';
    END IF;
    IF v_reception.id IS NULL OR v_reception.status <> 'awaiting_delivery' THEN
      RAISE EXCEPTION 'the reception is not awaiting delivery' USING ERRCODE = '23514';
    END IF;
  ELSIF p_delivery_type = 'institutional_copy_handover' THEN
    IF v_exchange.status <> 'in_process' THEN
      RAISE EXCEPTION 'a handover requires an in-process exchange' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF v_reception.id IS NULL OR v_reception.status <> 'return_pending' THEN
      RAISE EXCEPTION 'the reception is not pending return' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.deliveries d
    WHERE d.exchange_id = p_exchange_id AND d.delivery_type = p_delivery_type
      AND d.status IN ('scheduled', 'in_progress', 'completed')
  ) THEN
    RAISE EXCEPTION 'a delivery of this type already exists for the exchange' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.deliveries
    (request_id, reception_id, exchange_id, delivery_type, status, scheduled_at, recorded_by, idempotency_key)
  VALUES
    (v_request_id, v_reception.id, p_exchange_id, p_delivery_type, 'scheduled',
     coalesce(p_scheduled_at, clock_timestamp()), p_actor_user_id, p_idempotency_key)
  RETURNING id INTO v_delivery_id;

  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'delivery.scheduled', 'delivery', v_delivery_id::TEXT,
     jsonb_build_object('exchange_id', p_exchange_id, 'type', p_delivery_type));

  RETURN v_delivery_id;
END;
$function$;

CREATE FUNCTION public.confirm_delivery(
  p_delivery_id BIGINT,
  p_actor_user_id BIGINT,
  p_receipt_reference TEXT,
  p_notes TEXT,
  p_idempotency_key UUID
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_delivery public.deliveries%ROWTYPE;
  v_exchange_id BIGINT;
  v_request_id BIGINT;
  v_reception public.receptions%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'delivery.confirm');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT exchange_id, request_id INTO v_exchange_id, v_request_id
  FROM public.deliveries WHERE id = p_delivery_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.exchange_requests WHERE id = v_request_id FOR UPDATE;
  IF v_exchange_id IS NOT NULL THEN
    PERFORM 1 FROM public.exchanges WHERE id = v_exchange_id FOR UPDATE;
  END IF;
  SELECT * INTO v_delivery FROM public.deliveries WHERE id = p_delivery_id FOR UPDATE;

  IF v_delivery.idempotency_key IS DISTINCT FROM p_idempotency_key THEN
    RAISE EXCEPTION 'delivery idempotency key mismatch' USING ERRCODE = '23505';
  END IF;
  IF v_delivery.status = 'completed' THEN
    RETURN v_delivery.id;
  END IF;
  IF v_delivery.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'delivery is not confirmable' USING ERRCODE = '23514';
  END IF;
  IF length(trim(coalesce(p_receipt_reference, ''))) < 1 THEN
    RAISE EXCEPTION 'a receipt reference is required to confirm a delivery' USING ERRCODE = '23514';
  END IF;

  UPDATE public.deliveries
  SET status = 'completed', completed_at = clock_timestamp(), completed_by = p_actor_user_id,
      receipt_reference = p_receipt_reference, notes = left(p_notes, 2000)
  WHERE id = p_delivery_id;

  IF v_delivery.delivery_type = 'offered_book_dropoff' THEN
    SELECT * INTO v_reception FROM public.receptions WHERE id = v_delivery.reception_id FOR UPDATE;
    IF v_reception.status = 'awaiting_delivery' THEN
      UPDATE public.receptions
      SET status = 'received', received_at = clock_timestamp(), received_by = p_actor_user_id
      WHERE id = v_reception.id;
      INSERT INTO public.reception_status_history
        (reception_id, previous_status, new_status, changed_by, reason)
      VALUES
        (v_reception.id, 'awaiting_delivery', 'received', p_actor_user_id, 'dropoff confirmed');
      INSERT INTO public.state_history
        (entity_type, entity_id, previous_state, new_state, changed_by, reason)
      VALUES
        ('reception', v_reception.id, 'awaiting_delivery', 'received', p_actor_user_id, 'dropoff confirmed');
    END IF;
  ELSIF v_delivery.delivery_type = 'offered_book_return' THEN
    SELECT * INTO v_reception FROM public.receptions WHERE id = v_delivery.reception_id FOR UPDATE;
    IF v_reception.status <> 'return_pending' THEN
      RAISE EXCEPTION 'the reception is not pending return' USING ERRCODE = '23514';
    END IF;
    UPDATE public.receptions SET status = 'returned' WHERE id = v_reception.id;
    INSERT INTO public.reception_status_history
      (reception_id, previous_status, new_status, changed_by, reason)
    VALUES
      (v_reception.id, 'return_pending', 'returned', p_actor_user_id, 'return confirmed');
    INSERT INTO public.state_history
      (entity_type, entity_id, previous_state, new_state, changed_by, reason)
    VALUES
      ('reception', v_reception.id, 'return_pending', 'returned', p_actor_user_id, 'return confirmed');
  END IF;

  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'delivery.completed', 'delivery', p_delivery_id::TEXT,
     jsonb_build_object('type', v_delivery.delivery_type));

  RETURN p_delivery_id;
END;
$function$;

CREATE FUNCTION public.place_reception_in_custody(
  p_reception_id BIGINT,
  p_actor_user_id BIGINT,
  p_location TEXT,
  p_custodian TEXT,
  p_evidence_reference TEXT,
  p_idempotency_key UUID
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_reception public.receptions%ROWTYPE;
  v_existing public.reception_custody_events%ROWTYPE;
  v_event_id BIGINT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'custody.transfer');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT * INTO v_existing FROM public.reception_custody_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_existing.id;
  END IF;

  SELECT * INTO v_reception FROM public.receptions WHERE id = p_reception_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reception not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_reception.status <> 'received' THEN
    RAISE EXCEPTION 'a reception must be received before custody' USING ERRCODE = '23514';
  END IF;
  IF length(trim(coalesce(p_location, ''))) < 1
     OR length(trim(coalesce(p_custodian, ''))) < 1
     OR length(trim(coalesce(p_evidence_reference, ''))) < 1 THEN
    RAISE EXCEPTION 'location, custodian and evidence are required' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.reception_custody_events
    (reception_id, location, custodian, evidence_reference, idempotency_key, recorded_by)
  VALUES
    (p_reception_id, p_location, p_custodian, p_evidence_reference, p_idempotency_key, p_actor_user_id)
  RETURNING id INTO v_event_id;

  UPDATE public.receptions SET status = 'in_custody' WHERE id = p_reception_id;
  INSERT INTO public.reception_status_history
    (reception_id, previous_status, new_status, changed_by, reason)
  VALUES
    (p_reception_id, 'received', 'in_custody', p_actor_user_id, 'custody recorded');
  INSERT INTO public.state_history
    (entity_type, entity_id, previous_state, new_state, changed_by, reason)
  VALUES
    ('reception', p_reception_id, 'received', 'in_custody', p_actor_user_id, 'custody recorded');

  RETURN v_event_id;
END;
$function$;

CREATE FUNCTION public.evaluate_reception(
  p_reception_id BIGINT,
  p_actor_user_id BIGINT,
  p_outcome TEXT,
  p_assessed_condition TEXT,
  p_rationale TEXT,
  p_idempotency_key UUID,
  p_evidence_reference TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_reception public.receptions%ROWTYPE;
  v_existing public.book_evaluations%ROWTYPE;
  v_exchange public.exchanges%ROWTYPE;
  v_reservation public.reservations%ROWTYPE;
  v_evaluation_id BIGINT;
  v_request_status TEXT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'reception.evaluate');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT * INTO v_existing FROM public.book_evaluations WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_existing.id;
  END IF;

  SELECT * INTO v_reception FROM public.receptions WHERE id = p_reception_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reception not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_reception.status <> 'in_custody' THEN
    RAISE EXCEPTION 'a reception must be in custody before evaluation' USING ERRCODE = '23514';
  END IF;
  IF p_outcome NOT IN ('accepted', 'rejected') THEN
    RAISE EXCEPTION 'evaluation outcome must be accepted or rejected' USING ERRCODE = '23514';
  END IF;
  IF p_assessed_condition NOT IN ('excellent', 'good', 'fair', 'poor') THEN
    RAISE EXCEPTION 'assessed condition is invalid' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.book_evaluations
    (reception_id, evaluator_id, outcome, assessed_condition, rationale, is_final, idempotency_key, evidence_reference)
  VALUES
    (p_reception_id, p_actor_user_id, p_outcome, p_assessed_condition, p_rationale, TRUE, p_idempotency_key, p_evidence_reference)
  RETURNING id INTO v_evaluation_id;

  IF p_outcome = 'accepted' THEN
    IF length(trim(coalesce(p_evidence_reference, ''))) < 1 THEN
      RAISE EXCEPTION 'property transfer evidence is required for an accepted book' USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.ownership_transfers
      (reception_id, request_id, participant_id, transferor_type, transferee_type,
       accepted_by, evidence_reference, idempotency_key)
    SELECT v_reception.id, r.id, r.participant_id, 'participant', 'institution',
           p_actor_user_id, p_evidence_reference, md5(p_idempotency_key::TEXT || ':transfer')::UUID
    FROM public.exchange_requests r WHERE r.id = v_reception.request_id;

    UPDATE public.receptions SET status = 'evaluated' WHERE id = p_reception_id;
    INSERT INTO public.reception_status_history
      (reception_id, previous_status, new_status, changed_by, reason)
    VALUES
      (p_reception_id, 'in_custody', 'evaluated', p_actor_user_id, 'evaluation accepted');
    INSERT INTO public.state_history
      (entity_type, entity_id, previous_state, new_state, changed_by, reason)
    VALUES
      ('reception', p_reception_id, 'in_custody', 'evaluated', p_actor_user_id, 'evaluation accepted');
  ELSE
    UPDATE public.receptions SET status = 'rejected' WHERE id = p_reception_id;
    INSERT INTO public.reception_status_history
      (reception_id, previous_status, new_status, changed_by, reason)
    VALUES
      (p_reception_id, 'in_custody', 'rejected', p_actor_user_id, 'evaluation rejected');
    INSERT INTO public.state_history
      (entity_type, entity_id, previous_state, new_state, changed_by, reason)
    VALUES
      ('reception', p_reception_id, 'in_custody', 'rejected', p_actor_user_id, 'evaluation rejected');

    FOR v_exchange IN
      SELECT * FROM public.exchanges WHERE request_id = v_reception.request_id AND status = 'planned' FOR UPDATE
    LOOP
      UPDATE public.exchanges
      SET status = 'cancelled',
          cancellation_idempotency_key = md5(p_idempotency_key::TEXT || ':exchange-cancel')::UUID,
          cancelled_at = clock_timestamp()
      WHERE id = v_exchange.id;
      INSERT INTO public.state_history
        (entity_type, entity_id, previous_state, new_state, changed_by, reason)
      VALUES
        ('exchange', v_exchange.id, 'planned', 'cancelled', p_actor_user_id, 'offered book rejected');
    END LOOP;

    SELECT * INTO v_reservation
    FROM public.reservations
    WHERE request_id = v_reception.request_id AND status = 'active'
    FOR UPDATE;
    IF FOUND THEN
      UPDATE public.reservations
      SET status = 'released', released_at = clock_timestamp()
      WHERE id = v_reservation.id;
      UPDATE public.copies
      SET availability = 'available'
      WHERE id = v_reservation.copy_id AND availability = 'reserved';
      INSERT INTO public.inventory_movements
        (copy_id, movement_type, previous_availability, new_availability, reason)
      VALUES
        (v_reservation.copy_id, 'reservation_released', 'reserved', 'available', 'offered book rejected');
    END IF;

    SELECT status INTO v_request_status
    FROM public.exchange_requests WHERE id = v_reception.request_id FOR UPDATE;
    IF v_request_status NOT IN ('pending', 'under_review', 'approved', 'scheduled') THEN
      RAISE EXCEPTION 'the request cannot be rejected from status %', v_request_status USING ERRCODE = '23514';
    END IF;
    UPDATE public.exchange_requests SET status = 'rejected' WHERE id = v_reception.request_id;
    INSERT INTO public.request_status_history
      (request_id, previous_status, new_status, changed_by, reason)
    VALUES
      (v_reception.request_id, v_request_status, 'rejected', p_actor_user_id, 'offered book rejected');
    INSERT INTO public.state_history
      (entity_type, entity_id, previous_state, new_state, changed_by, reason)
    VALUES
      ('exchange_request', v_reception.request_id, v_request_status, 'rejected', p_actor_user_id, 'offered book rejected');
  END IF;

  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'reception.evaluated', 'reception', p_reception_id::TEXT,
     jsonb_build_object('outcome', p_outcome, 'evaluation_id', v_evaluation_id));

  RETURN v_evaluation_id;
END;
$function$;

CREATE FUNCTION public.request_reception_return(
  p_reception_id BIGINT,
  p_actor_user_id BIGINT,
  p_reason TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_reception public.receptions%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'reception.return');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT * INTO v_reception FROM public.receptions WHERE id = p_reception_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reception not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_reception.status <> 'rejected' THEN
    RAISE EXCEPTION 'only a rejected reception can be returned' USING ERRCODE = '23514';
  END IF;

  UPDATE public.receptions SET status = 'return_pending' WHERE id = p_reception_id;
  INSERT INTO public.reception_status_history
    (reception_id, previous_status, new_status, changed_by, reason)
  VALUES
    (p_reception_id, 'rejected', 'return_pending', p_actor_user_id, left(coalesce(p_reason, ''), 3000));
  INSERT INTO public.state_history
    (entity_type, entity_id, previous_state, new_state, changed_by, reason)
  VALUES
    ('reception', p_reception_id, 'rejected', 'return_pending', p_actor_user_id, left(coalesce(p_reason, ''), 3000));

  RETURN p_reception_id;
END;
$function$;

CREATE FUNCTION public.record_cataloging_validation(
  p_reception_id BIGINT,
  p_bibliographic_record_id BIGINT,
  p_actor_user_id BIGINT,
  p_validation_key UUID
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_reception public.receptions%ROWTYPE;
  v_existing public.cataloging_records%ROWTYPE;
  v_cataloging_id BIGINT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'cataloging.validate');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT * INTO v_existing FROM public.cataloging_records WHERE validation_key = p_validation_key;
  IF FOUND THEN
    RETURN v_existing.id;
  END IF;

  SELECT * INTO v_reception FROM public.receptions WHERE id = p_reception_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reception not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_reception.status <> 'evaluated' THEN
    RAISE EXCEPTION 'a reception must be evaluated before cataloging' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.book_evaluations e
    WHERE e.reception_id = p_reception_id AND e.outcome = 'accepted' AND e.is_final
  ) THEN
    RAISE EXCEPTION 'an accepted evaluation is required before cataloging' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bibliographic_records b WHERE b.id = p_bibliographic_record_id) THEN
    RAISE EXCEPTION 'bibliographic record not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cataloging_records c WHERE c.reception_id = p_reception_id) THEN
    RAISE EXCEPTION 'cataloging already exists for the reception' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.cataloging_records
    (reception_id, bibliographic_record_id, status, validated_by, validated_at, validation_key)
  VALUES
    (p_reception_id, p_bibliographic_record_id, 'validated', p_actor_user_id, clock_timestamp(), p_validation_key)
  RETURNING id INTO v_cataloging_id;

  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'cataloging.validated', 'cataloging_record', v_cataloging_id::TEXT,
     jsonb_build_object('reception_id', p_reception_id));

  RETURN v_cataloging_id;
END;
$function$;

CREATE FUNCTION public.authorize_cataloging(
  p_cataloging_id BIGINT,
  p_actor_user_id BIGINT,
  p_authorization_key UUID
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_cataloging public.cataloging_records%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'cataloging.authorize');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT * INTO v_cataloging FROM public.cataloging_records WHERE id = p_cataloging_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cataloging record not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_cataloging.status = 'authorized' AND v_cataloging.authorization_key = p_authorization_key THEN
    RETURN v_cataloging.id;
  END IF;
  IF v_cataloging.status <> 'validated' THEN
    RAISE EXCEPTION 'cataloging must be validated before authorization' USING ERRCODE = '23514';
  END IF;
  IF v_cataloging.validated_by = p_actor_user_id THEN
    RAISE EXCEPTION 'a different user must authorize the cataloging' USING ERRCODE = '23514';
  END IF;

  UPDATE public.cataloging_records
  SET status = 'authorized', authorized_by = p_actor_user_id, authorized_at = clock_timestamp(),
      authorization_key = p_authorization_key
  WHERE id = p_cataloging_id;

  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'cataloging.authorized', 'cataloging_record', p_cataloging_id::TEXT, '{}'::JSONB);

  RETURN p_cataloging_id;
END;
$function$;

CREATE FUNCTION public.authorize_inventory_admission(
  p_reception_id BIGINT,
  p_actor_user_id BIGINT,
  p_idempotency_key UUID
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_reception public.receptions%ROWTYPE;
  v_existing public.inventory_admissions%ROWTYPE;
  v_evaluation public.book_evaluations%ROWTYPE;
  v_cataloging public.cataloging_records%ROWTYPE;
  v_transfer public.ownership_transfers%ROWTYPE;
  v_admission_id BIGINT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'inventory.admit');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT * INTO v_existing FROM public.inventory_admissions WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_existing.id;
  END IF;

  SELECT * INTO v_reception FROM public.receptions WHERE id = p_reception_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reception not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.inventory_admissions a WHERE a.reception_id = p_reception_id) THEN
    RAISE EXCEPTION 'an admission already exists for the reception' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO v_evaluation
  FROM public.book_evaluations
  WHERE reception_id = p_reception_id AND is_final
  FOR SHARE;
  IF NOT FOUND OR v_evaluation.outcome <> 'accepted' THEN
    RAISE EXCEPTION 'an accepted final evaluation is required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_cataloging FROM public.cataloging_records WHERE reception_id = p_reception_id FOR SHARE;
  IF NOT FOUND OR v_cataloging.status <> 'authorized' THEN
    RAISE EXCEPTION 'authorized cataloging is required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_transfer FROM public.ownership_transfers WHERE reception_id = p_reception_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an accepted property transfer is required' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.inventory_admissions
    (reception_id, evaluation_id, cataloging_record_id, ownership_transfer_id,
     status, authorized_by, authorized_at, idempotency_key)
  VALUES
    (p_reception_id, v_evaluation.id, v_cataloging.id, v_transfer.id,
     'authorized', p_actor_user_id, clock_timestamp(), p_idempotency_key)
  RETURNING id INTO v_admission_id;

  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'inventory.admission_authorized', 'inventory_admission', v_admission_id::TEXT,
     jsonb_build_object('reception_id', p_reception_id));

  RETURN v_admission_id;
END;
$function$;

CREATE FUNCTION public.admit_received_book(
  p_admission_id BIGINT,
  p_inventory_code TEXT,
  p_location TEXT,
  p_actor_user_id BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_admission public.inventory_admissions%ROWTYPE;
  v_evaluation public.book_evaluations%ROWTYPE;
  v_cataloging public.cataloging_records%ROWTYPE;
  v_transfer public.ownership_transfers%ROWTYPE;
  v_copy_id BIGINT;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'inventory.admit');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT * INTO v_admission FROM public.inventory_admissions WHERE id = p_admission_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admission not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_admission.copy_id IS NOT NULL THEN
    RETURN v_admission.copy_id;
  END IF;
  IF v_admission.status <> 'authorized' THEN
    RAISE EXCEPTION 'the admission must be authorized before admitting the copy' USING ERRCODE = '23514';
  END IF;
  IF length(trim(coalesce(p_inventory_code, ''))) < 1 THEN
    RAISE EXCEPTION 'an inventory code is required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_evaluation FROM public.book_evaluations WHERE id = v_admission.evaluation_id;
  SELECT * INTO v_cataloging FROM public.cataloging_records WHERE id = v_admission.cataloging_record_id;
  SELECT * INTO v_transfer FROM public.ownership_transfers WHERE id = v_admission.ownership_transfer_id;
  IF v_cataloging.bibliographic_record_id IS NULL THEN
    RAISE EXCEPTION 'the cataloging record has no bibliographic record' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.copies
    (bibliographic_record_id, inventory_code, physical_condition, availability, location,
     provenance_type, provenance_reference, source_admission_id, ownership_acquired_at)
  VALUES
    (v_cataloging.bibliographic_record_id, p_inventory_code, v_evaluation.assessed_condition,
     'unavailable', p_location, 'exchange_received',
     'reception:' || v_admission.reception_id::TEXT, v_admission.id, v_transfer.transferred_at)
  RETURNING id INTO v_copy_id;

  UPDATE public.inventory_admissions
  SET copy_id = v_copy_id, status = 'admitted',
      admitted_by = p_actor_user_id, admitted_at = clock_timestamp()
  WHERE id = p_admission_id;
  UPDATE public.cataloging_records SET copy_id = v_copy_id WHERE id = v_admission.cataloging_record_id;

  INSERT INTO public.inventory_movements
    (copy_id, movement_type, new_availability, performed_by, reason)
  VALUES
    (v_copy_id, 'received', 'unavailable', p_actor_user_id, 'admitted from participant exchange');

  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'inventory.copy_admitted', 'copy', v_copy_id::TEXT,
     jsonb_build_object('admission_id', p_admission_id));

  RETURN v_copy_id;
END;
$function$;

CREATE FUNCTION public.enable_received_copy(p_admission_id BIGINT, p_actor_user_id BIGINT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_admission public.inventory_admissions%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'inventory.enable');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT * INTO v_admission FROM public.inventory_admissions WHERE id = p_admission_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admission not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_admission.status = 'enabled' THEN
    RETURN v_admission.copy_id;
  END IF;
  IF v_admission.status <> 'admitted' OR v_admission.copy_id IS NULL THEN
    RAISE EXCEPTION 'the admission must be admitted before enabling the copy' USING ERRCODE = '23514';
  END IF;

  UPDATE public.inventory_admissions
  SET status = 'enabled', enabled_by = p_actor_user_id, enabled_at = clock_timestamp()
  WHERE id = p_admission_id;
  UPDATE public.copies SET availability = 'available' WHERE id = v_admission.copy_id;
  INSERT INTO public.inventory_movements
    (copy_id, movement_type, previous_availability, new_availability, performed_by, reason)
  VALUES
    (v_admission.copy_id, 'availability_changed', 'unavailable', 'available',
     p_actor_user_id, 'admitted copy enabled for exchange');

  RETURN v_admission.copy_id;
END;
$function$;

CREATE FUNCTION public.start_exchange(p_exchange_id BIGINT, p_actor_user_id BIGINT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request_id BIGINT;
  v_request public.exchange_requests%ROWTYPE;
  v_exchange public.exchanges%ROWTYPE;
  v_copy public.copies%ROWTYPE;
  v_reservation public.reservations%ROWTYPE;
  v_offered public.inventory_admissions%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'exchange.start');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT request_id INTO v_request_id FROM public.exchanges WHERE id = p_exchange_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exchange not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_request FROM public.exchange_requests WHERE id = v_request_id FOR UPDATE;
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

  SELECT * INTO v_offered
  FROM public.inventory_admissions
  WHERE reception_id = v_exchange.offered_reception_id
  FOR SHARE;
  IF NOT FOUND OR v_offered.status <> 'enabled' OR v_offered.copy_id IS NULL THEN
    RAISE EXCEPTION 'the offered book must be admitted and enabled before starting' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_copy FROM public.copies WHERE id = v_exchange.institutional_copy_id FOR UPDATE;
  IF v_copy.availability <> 'reserved' THEN
    RAISE EXCEPTION 'the institutional copy is not reserved' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_reservation
  FROM public.reservations
  WHERE request_id = v_request_id AND copy_id = v_exchange.institutional_copy_id
    AND status = 'active' AND expires_at > clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an active reservation is required to start the exchange' USING ERRCODE = '23514';
  END IF;

  UPDATE public.reservations
  SET status = 'converted', released_at = clock_timestamp()
  WHERE id = v_reservation.id;
  UPDATE public.exchanges
  SET status = 'in_process', offered_copy_id = coalesce(offered_copy_id, v_offered.copy_id)
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
     jsonb_build_object('request_id', v_request_id));

  RETURN p_exchange_id;
END;
$function$;

CREATE FUNCTION public.complete_exchange(
  p_exchange_id BIGINT,
  p_completion_key UUID,
  p_actor_user_id BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request_id BIGINT;
  v_request public.exchange_requests%ROWTYPE;
  v_exchange public.exchanges%ROWTYPE;
  v_admission public.inventory_admissions%ROWTYPE;
  v_evaluation public.book_evaluations%ROWTYPE;
  v_cataloging public.cataloging_records%ROWTYPE;
  v_reservation public.reservations%ROWTYPE;
  v_offered_copy public.copies%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'exchange.complete');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT request_id INTO v_request_id FROM public.exchanges WHERE id = p_exchange_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exchange not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_request FROM public.exchange_requests WHERE id = v_request_id FOR UPDATE;
  SELECT * INTO v_exchange FROM public.exchanges WHERE id = p_exchange_id FOR UPDATE;

  IF v_exchange.status = 'completed' THEN
    IF v_exchange.completion_idempotency_key = p_completion_key THEN
      RETURN v_exchange.id;
    END IF;
    RAISE EXCEPTION 'exchange already completed with a different idempotency key' USING ERRCODE = '23505';
  END IF;
  IF v_exchange.status <> 'in_process' THEN
    RAISE EXCEPTION 'exchange is not in process' USING ERRCODE = '23514';
  END IF;
  IF v_request.status <> 'in_process' THEN
    RAISE EXCEPTION 'request is not in process' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_admission
  FROM public.inventory_admissions
  WHERE reception_id = v_exchange.offered_reception_id
  FOR SHARE;
  IF NOT FOUND OR v_admission.status <> 'enabled' THEN
    RAISE EXCEPTION 'physical receipt, accepted evaluation, and property transfer are required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_evaluation
  FROM public.book_evaluations
  WHERE reception_id = v_exchange.offered_reception_id AND is_final
  FOR SHARE;
  IF NOT FOUND OR v_evaluation.outcome <> 'accepted' THEN
    RAISE EXCEPTION 'an accepted final evaluation is required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_cataloging
  FROM public.cataloging_records
  WHERE reception_id = v_exchange.offered_reception_id
  FOR SHARE;
  IF NOT FOUND OR v_cataloging.status <> 'authorized' THEN
    RAISE EXCEPTION 'authorized cataloging is required' USING ERRCODE = '23514';
  END IF;

  IF (
    SELECT count(*) FROM public.deliveries d
    WHERE d.exchange_id = p_exchange_id AND d.request_id = v_request_id
      AND d.reception_id = v_exchange.offered_reception_id
      AND d.status = 'completed' AND d.completed_at IS NOT NULL AND d.completed_by IS NOT NULL
      AND d.receipt_reference IS NOT NULL
      AND d.delivery_type IN ('offered_book_dropoff', 'institutional_copy_handover')
  ) <> 2 THEN
    RAISE EXCEPTION 'confirmed and documented receipt and institutional handover are required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_offered_copy
  FROM public.copies
  WHERE id = v_exchange.offered_copy_id AND availability = 'available'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the offered admitted copy is not available' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_reservation
  FROM public.reservations
  WHERE request_id = v_request_id AND copy_id = v_exchange.institutional_copy_id
    AND status = 'converted'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the in-process exchange reservation hold is required at handover' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.inventory_movements
    (copy_id, exchange_id, reception_id, movement_type, previous_availability, new_availability,
     idempotency_key, performed_by, reason)
  VALUES
    (v_exchange.institutional_copy_id, p_exchange_id, v_exchange.offered_reception_id,
     'exchange_out', 'reserved', 'retired', p_completion_key, p_actor_user_id, 'documented exchange handover'),
    (v_exchange.offered_copy_id, p_exchange_id, v_exchange.offered_reception_id,
     'exchange_in', 'available', 'available', md5(p_completion_key::TEXT || ':in')::UUID,
     p_actor_user_id, 'received offered book');

  UPDATE public.copies SET availability = 'retired' WHERE id = v_exchange.institutional_copy_id;
  UPDATE public.exchanges
  SET status = 'completed', completed_at = clock_timestamp(), completion_idempotency_key = p_completion_key
  WHERE id = p_exchange_id;
  UPDATE public.exchange_requests SET status = 'completed' WHERE id = v_request_id;

  INSERT INTO public.request_status_history
    (request_id, previous_status, new_status, changed_by, reason)
  VALUES
    (v_request_id, 'in_process', 'completed', p_actor_user_id, 'exchange completed');
  INSERT INTO public.state_history
    (entity_type, entity_id, previous_state, new_state, changed_by, reason)
  VALUES
    ('exchange', p_exchange_id, 'in_process', 'completed', p_actor_user_id, 'exchange completed'),
    ('exchange_request', v_request_id, 'in_process', 'completed', p_actor_user_id, 'exchange completed');
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'exchange.completed', 'exchange', p_exchange_id::TEXT,
     jsonb_build_object('request_id', v_request_id));

  RETURN p_exchange_id;
END;
$function$;

CREATE FUNCTION public.cancel_exchange(
  p_exchange_id BIGINT,
  p_cancellation_key UUID,
  p_actor_user_id BIGINT,
  p_reason TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request_id BIGINT;
  v_request public.exchange_requests%ROWTYPE;
  v_exchange public.exchanges%ROWTYPE;
  v_reservation public.reservations%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'exchange.cancel');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT request_id INTO v_request_id FROM public.exchanges WHERE id = p_exchange_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exchange not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_request FROM public.exchange_requests WHERE id = v_request_id FOR UPDATE;
  SELECT * INTO v_exchange FROM public.exchanges WHERE id = p_exchange_id FOR UPDATE;

  IF v_exchange.status = 'cancelled' THEN
    IF v_exchange.cancellation_idempotency_key = p_cancellation_key THEN
      RETURN v_exchange.id;
    END IF;
    RAISE EXCEPTION 'exchange already cancelled with a different idempotency key' USING ERRCODE = '23505';
  END IF;
  IF v_exchange.status = 'completed' THEN
    RAISE EXCEPTION 'a completed exchange cannot be cancelled' USING ERRCODE = '23514';
  END IF;
  IF v_exchange.status <> 'in_process' OR v_request.status <> 'in_process' THEN
    RAISE EXCEPTION 'only an in-process exchange can use this cancellation routine' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.deliveries d
    WHERE d.exchange_id = p_exchange_id
      AND d.delivery_type = 'institutional_copy_handover' AND d.status = 'completed'
  ) THEN
    RAISE EXCEPTION 'a confirmed institutional handover must be completed, not cancelled' USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.copies WHERE id = v_exchange.institutional_copy_id FOR UPDATE;
  SELECT * INTO v_reservation
  FROM public.reservations
  WHERE request_id = v_request_id AND copy_id = v_exchange.institutional_copy_id
    AND status = 'converted'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the in-process exchange reservation hold was not found' USING ERRCODE = '23514';
  END IF;

  UPDATE public.deliveries
  SET status = 'cancelled'
  WHERE exchange_id = p_exchange_id AND delivery_type = 'institutional_copy_handover'
    AND status IN ('scheduled', 'in_progress');
  UPDATE public.reservations
  SET status = 'released', released_at = clock_timestamp()
  WHERE id = v_reservation.id;
  UPDATE public.copies
  SET availability = 'available'
  WHERE id = v_exchange.institutional_copy_id AND availability = 'reserved';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the institutional copy is not releasable' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.inventory_movements
    (copy_id, exchange_id, reception_id, movement_type, previous_availability, new_availability,
     idempotency_key, performed_by, reason)
  VALUES
    (v_exchange.institutional_copy_id, p_exchange_id, v_exchange.offered_reception_id,
     'reservation_released', 'reserved', 'available', p_cancellation_key, p_actor_user_id,
     left(coalesce(p_reason, ''), 2000));

  UPDATE public.exchanges
  SET status = 'cancelled', cancellation_idempotency_key = p_cancellation_key,
      cancelled_at = clock_timestamp()
  WHERE id = p_exchange_id;
  UPDATE public.exchange_requests SET status = 'cancelled' WHERE id = v_request_id;

  INSERT INTO public.request_status_history
    (request_id, previous_status, new_status, changed_by, reason)
  VALUES
    (v_request_id, 'in_process', 'cancelled', p_actor_user_id, left(coalesce(p_reason, ''), 3000));
  INSERT INTO public.state_history
    (entity_type, entity_id, previous_state, new_state, changed_by, reason)
  VALUES
    ('exchange', p_exchange_id, 'in_process', 'cancelled', p_actor_user_id, left(coalesce(p_reason, ''), 3000)),
    ('exchange_request', v_request_id, 'in_process', 'cancelled', p_actor_user_id, left(coalesce(p_reason, ''), 3000));
  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'exchange.cancelled', 'exchange', p_exchange_id::TEXT,
     jsonb_build_object('request_id', v_request_id, 'reason', left(coalesce(p_reason, ''), 2000)));

  RETURN p_exchange_id;
END;
$function$;

CREATE FUNCTION public.get_participant_contact(p_participant_id BIGINT, p_actor_user_id BIGINT)
RETURNS TABLE (participant_id BIGINT, full_name_ciphertext BYTEA, email_ciphertext BYTEA)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_participant public.participants%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'participants.read_contact');
  SELECT * INTO v_participant FROM public.participants WHERE id = p_participant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'participant not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'participant.contact_read', 'participant', p_participant_id::TEXT, '{}'::JSONB);

  participant_id := v_participant.id;
  full_name_ciphertext := v_participant.full_name_ciphertext;
  email_ciphertext := v_participant.email_ciphertext;
  RETURN NEXT;
END;
$function$;

CREATE FUNCTION public.withdraw_privacy_consent(
  p_consent_id BIGINT,
  p_actor_user_id BIGINT,
  p_evidence_sha256 BYTEA,
  p_idempotency_key UUID
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_consent public.privacy_consents%ROWTYPE;
BEGIN
  PERFORM public.assert_actor_permission(p_actor_user_id, 'privacy.withdraw');
  PERFORM set_config('app.actor_user_id', p_actor_user_id::TEXT, TRUE);

  SELECT * INTO v_consent FROM public.privacy_consents WHERE id = p_consent_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'consent not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_consent.withdrawn_at IS NOT NULL THEN
    IF v_consent.withdrawal_idempotency_key = p_idempotency_key THEN
      RETURN v_consent.id;
    END IF;
    RAISE EXCEPTION 'consent already withdrawn with a different idempotency key' USING ERRCODE = '23505';
  END IF;
  IF p_evidence_sha256 IS NULL OR octet_length(p_evidence_sha256) <> 32 THEN
    RAISE EXCEPTION 'a withdrawal evidence digest is required' USING ERRCODE = '23514';
  END IF;

  UPDATE public.privacy_consents
  SET withdrawn_at = clock_timestamp(),
      withdrawal_evidence_sha256 = p_evidence_sha256,
      withdrawn_by = p_actor_user_id,
      withdrawal_idempotency_key = p_idempotency_key
  WHERE id = p_consent_id;

  INSERT INTO public.audit_events (actor_user_id, event_type, resource_type, resource_id, metadata)
  VALUES
    (p_actor_user_id, 'privacy.consent_withdrawn', 'privacy_consent', p_consent_id::TEXT, '{}'::JSONB);

  RETURN p_consent_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Public catalogue and permission catalogue
-- ---------------------------------------------------------------------------

CREATE VIEW public.available_catalog WITH (security_barrier = TRUE) AS
SELECT
  c.id AS copy_id,
  b.id AS bibliographic_record_id,
  b.title,
  b.author,
  b.isbn,
  b.edition,
  b.publication_year,
  p.name AS publisher,
  g.name AS genre,
  c.inventory_code,
  c.physical_condition,
  c.location
FROM public.copies c
JOIN public.bibliographic_records b ON b.id = c.bibliographic_record_id
LEFT JOIN public.publishers p ON p.id = b.publisher_id
LEFT JOIN public.genres g ON g.id = b.genre_id
WHERE c.availability = 'available';

INSERT INTO public.permissions (permission_key, description) VALUES
  ('requests.review', 'Revisar y cambiar solicitudes'),
  ('participants.read_contact', 'Consultar datos de contacto para gestionar una solicitud'),
  ('privacy.withdraw', 'Registrar retiro de autorizacion de tratamiento'),
  ('reception.evaluate', 'Evaluar libros recibidos'),
  ('reception.return', 'Coordinar devolucion de libros rechazados'),
  ('custody.transfer', 'Registrar transferencias de custodia'),
  ('cataloging.validate', 'Validar datos bibliograficos'),
  ('cataloging.authorize', 'Autorizar catalogaciones'),
  ('inventory.admit', 'Autorizar y admitir ejemplares recibidos'),
  ('inventory.enable', 'Habilitar ejemplares catalogados'),
  ('reservations.configure', 'Configurar la politica de reservas'),
  ('reservations.expire', 'Liberar reservas vencidas'),
  ('delivery.schedule', 'Programar entregas de un intercambio'),
  ('delivery.confirm', 'Confirmar entregas con evidencia'),
  ('exchange.plan', 'Programar un intercambio aprobado'),
  ('exchange.start', 'Iniciar un intercambio planificado'),
  ('exchange.complete', 'Cerrar intercambios con ambos movimientos'),
  ('exchange.cancel', 'Cancelar un intercambio en proceso')
ON CONFLICT (permission_key) DO NOTHING;
