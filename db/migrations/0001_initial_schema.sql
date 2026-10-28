-- Propuesta inicial revisada contra un esquema de Neon sin objetos de usuario.
-- Se ejecuta solo mediante scripts/migrate.mjs y nunca durante build/deploy.
-- No incluye DROP, TRUNCATE ni operaciones de borrado.

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version TEXT PRIMARY KEY,
  checksum CHAR(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.app_users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  identity_subject TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.roles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role_key TEXT NOT NULL UNIQUE CHECK (role_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  display_name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.permissions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  permission_key TEXT NOT NULL UNIQUE CHECK (permission_key ~ '^[a-z][a-z0-9_.-]{1,95}$'),
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id BIGINT NOT NULL REFERENCES public.app_users(id),
  role_id BIGINT NOT NULL REFERENCES public.roles(id),
  assigned_by BIGINT REFERENCES public.app_users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS public.role_permissions (
  role_id BIGINT NOT NULL REFERENCES public.roles(id),
  permission_id BIGINT NOT NULL REFERENCES public.permissions(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS public.participants (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name TEXT NOT NULL CHECK (length(trim(full_name)) BETWEEN 1 AND 250),
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  identity_ciphertext BYTEA NOT NULL,
  identity_fingerprint BYTEA NOT NULL UNIQUE CHECK (octet_length(identity_fingerprint) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.participants.identity_ciphertext IS
  'Cifrado a nivel de aplicación; nunca almacenar el documento en texto claro.';
COMMENT ON COLUMN public.participants.identity_fingerprint IS
  'HMAC-SHA-256 con clave privada del servidor para detección de duplicados.';

CREATE TABLE IF NOT EXISTS public.publishers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 250),
  normalized_name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.genres (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  normalized_name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bibliographic_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 500),
  author TEXT NOT NULL CHECK (length(trim(author)) BETWEEN 1 AND 500),
  publisher_id BIGINT REFERENCES public.publishers(id),
  genre_id BIGINT REFERENCES public.genres(id),
  isbn TEXT,
  isbn_normalized TEXT,
  edition TEXT,
  publication_year SMALLINT CHECK (publication_year BETWEEN 1400 AND 2200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((isbn IS NULL AND isbn_normalized IS NULL) OR (isbn IS NOT NULL AND isbn_normalized IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS bibliographic_records_isbn_normalized_uidx
  ON public.bibliographic_records (isbn_normalized)
  WHERE isbn_normalized IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS bibliographic_records_without_isbn_uidx
  ON public.bibliographic_records (
    lower(title),
    lower(author),
    COALESCE(publisher_id, 0),
    lower(COALESCE(edition, ''))
  )
  WHERE isbn_normalized IS NULL;
CREATE INDEX IF NOT EXISTS bibliographic_records_title_lower_idx
  ON public.bibliographic_records (lower(title));
CREATE INDEX IF NOT EXISTS bibliographic_records_author_lower_idx
  ON public.bibliographic_records (lower(author));
CREATE INDEX IF NOT EXISTS bibliographic_records_publisher_idx
  ON public.bibliographic_records (publisher_id);
CREATE INDEX IF NOT EXISTS bibliographic_records_genre_idx
  ON public.bibliographic_records (genre_id);

CREATE TABLE IF NOT EXISTS public.copies (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bibliographic_record_id BIGINT NOT NULL REFERENCES public.bibliographic_records(id),
  inventory_code TEXT NOT NULL UNIQUE,
  physical_condition TEXT NOT NULL CHECK (physical_condition IN ('excellent', 'good', 'fair', 'poor', 'unassessed')),
  availability TEXT NOT NULL DEFAULT 'unavailable' CHECK (availability IN ('available', 'reserved', 'unavailable', 'maintenance', 'retired')),
  location TEXT,
  provenance_type TEXT NOT NULL CHECK (provenance_type IN ('institutional', 'donation', 'purchase', 'other')),
  provenance_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS copies_bibliographic_record_idx
  ON public.copies (bibliographic_record_id);
CREATE INDEX IF NOT EXISTS copies_available_idx
  ON public.copies (availability, id)
  WHERE availability = 'available';

CREATE TABLE IF NOT EXISTS public.exchange_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_code TEXT NOT NULL UNIQUE,
  participant_id BIGINT NOT NULL REFERENCES public.participants(id),
  requested_copy_id BIGINT NOT NULL REFERENCES public.copies(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'under_review', 'approved', 'rejected', 'scheduled', 'in_process', 'completed', 'cancelled')),
  idempotency_key TEXT UNIQUE,
  privacy_notice_version TEXT NOT NULL,
  consented_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS exchange_requests_status_created_idx
  ON public.exchange_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS exchange_requests_participant_idx
  ON public.exchange_requests (participant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS exchange_requests_requested_copy_idx
  ON public.exchange_requests (requested_copy_id);

CREATE TABLE IF NOT EXISTS public.offered_books (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id BIGINT NOT NULL UNIQUE REFERENCES public.exchange_requests(id),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 500),
  author TEXT NOT NULL CHECK (length(trim(author)) BETWEEN 1 AND 500),
  publisher_claim TEXT,
  genre_claim TEXT,
  isbn TEXT,
  isbn_normalized TEXT,
  declared_condition TEXT NOT NULL CHECK (declared_condition IN ('excellent', 'good', 'fair', 'poor')),
  observations TEXT CHECK (length(observations) <= 3000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((isbn IS NULL AND isbn_normalized IS NULL) OR (isbn IS NOT NULL AND isbn_normalized IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.book_images (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  offered_book_id BIGINT NOT NULL REFERENCES public.offered_books(id),
  image_side TEXT NOT NULL CHECK (image_side IN ('front_cover', 'back_cover')),
  storage_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
  sha256 BYTEA NOT NULL CHECK (octet_length(sha256) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (offered_book_id, image_side)
);

CREATE TABLE IF NOT EXISTS public.reservations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  copy_id BIGINT NOT NULL REFERENCES public.copies(id),
  request_id BIGINT NOT NULL REFERENCES public.exchange_requests(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'released', 'converted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS reservations_one_active_per_copy_uidx
  ON public.reservations (copy_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS reservations_one_active_per_request_uidx
  ON public.reservations (request_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS reservations_expiration_idx
  ON public.reservations (expires_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.receptions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id BIGINT NOT NULL UNIQUE REFERENCES public.exchange_requests(id),
  offered_book_id BIGINT NOT NULL UNIQUE REFERENCES public.offered_books(id),
  receipt_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'awaiting_delivery' CHECK (status IN ('awaiting_delivery', 'received', 'in_custody', 'evaluated', 'accepted', 'rejected', 'return_pending', 'returned')),
  received_at TIMESTAMPTZ,
  received_by BIGINT REFERENCES public.app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS receptions_status_created_idx
  ON public.receptions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.book_evaluations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reception_id BIGINT NOT NULL REFERENCES public.receptions(id),
  evaluator_id BIGINT NOT NULL REFERENCES public.app_users(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
  assessed_condition TEXT NOT NULL CHECK (assessed_condition IN ('excellent', 'good', 'fair', 'poor')),
  rationale TEXT NOT NULL CHECK (length(trim(rationale)) BETWEEN 1 AND 3000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS book_evaluations_reception_created_idx
  ON public.book_evaluations (reception_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.cataloging_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reception_id BIGINT NOT NULL UNIQUE REFERENCES public.receptions(id),
  bibliographic_record_id BIGINT REFERENCES public.bibliographic_records(id),
  copy_id BIGINT UNIQUE REFERENCES public.copies(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'validated', 'authorized')),
  validated_by BIGINT REFERENCES public.app_users(id),
  validated_at TIMESTAMPTZ,
  authorized_by BIGINT REFERENCES public.app_users(id),
  authorized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'validated' OR (bibliographic_record_id IS NOT NULL AND validated_by IS NOT NULL AND validated_at IS NOT NULL)),
  CHECK (status <> 'authorized' OR (bibliographic_record_id IS NOT NULL AND copy_id IS NOT NULL AND validated_by IS NOT NULL AND validated_at IS NOT NULL AND authorized_by IS NOT NULL AND authorized_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.deliveries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id BIGINT NOT NULL REFERENCES public.exchange_requests(id),
  reception_id BIGINT REFERENCES public.receptions(id),
  delivery_type TEXT NOT NULL CHECK (delivery_type IN ('offered_book_dropoff', 'offered_book_return', 'institutional_copy_handover')),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'missed')),
  scheduled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  receipt_reference TEXT,
  notes TEXT CHECK (length(notes) <= 2000),
  recorded_by BIGINT REFERENCES public.app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status <> 'completed') OR completed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS deliveries_status_schedule_idx
  ON public.deliveries (status, scheduled_at);
CREATE INDEX IF NOT EXISTS deliveries_request_idx
  ON public.deliveries (request_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.exchanges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id BIGINT NOT NULL UNIQUE REFERENCES public.exchange_requests(id),
  institutional_copy_id BIGINT NOT NULL REFERENCES public.copies(id),
  offered_copy_id BIGINT REFERENCES public.copies(id),
  accepted_reception_id BIGINT REFERENCES public.receptions(id),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_process', 'completed', 'cancelled')),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'completed' AND completed_at IS NOT NULL AND offered_copy_id IS NOT NULL AND accepted_reception_id IS NOT NULL) OR (status <> 'completed' AND completed_at IS NULL))
);

CREATE TABLE IF NOT EXISTS public.inventory_movements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  copy_id BIGINT NOT NULL REFERENCES public.copies(id),
  movement_type TEXT NOT NULL CHECK (movement_type IN ('received', 'reserved', 'reservation_released', 'availability_changed', 'location_changed', 'exchange_out', 'exchange_in', 'retired')),
  previous_availability TEXT CHECK (previous_availability IN ('available', 'reserved', 'unavailable', 'maintenance', 'retired')),
  new_availability TEXT CHECK (new_availability IN ('available', 'reserved', 'unavailable', 'maintenance', 'retired')),
  previous_location TEXT,
  new_location TEXT,
  reception_id BIGINT REFERENCES public.receptions(id),
  exchange_id BIGINT REFERENCES public.exchanges(id),
  reason TEXT CHECK (length(reason) <= 2000),
  performed_by BIGINT REFERENCES public.app_users(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_movements_copy_time_idx
  ON public.inventory_movements (copy_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS inventory_movements_exchange_idx
  ON public.inventory_movements (exchange_id)
  WHERE exchange_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.request_status_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id BIGINT NOT NULL REFERENCES public.exchange_requests(id),
  previous_status TEXT CHECK (previous_status IS NULL OR previous_status IN ('pending', 'under_review', 'approved', 'rejected', 'scheduled', 'in_process', 'completed', 'cancelled')),
  new_status TEXT NOT NULL CHECK (new_status IN ('pending', 'under_review', 'approved', 'rejected', 'scheduled', 'in_process', 'completed', 'cancelled')),
  changed_by BIGINT REFERENCES public.app_users(id),
  reason TEXT CHECK (length(reason) <= 3000),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS request_status_history_request_time_idx
  ON public.request_status_history (request_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS public.reception_status_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reception_id BIGINT NOT NULL REFERENCES public.receptions(id),
  previous_status TEXT CHECK (previous_status IS NULL OR previous_status IN ('awaiting_delivery', 'received', 'in_custody', 'evaluated', 'accepted', 'rejected', 'return_pending', 'returned')),
  new_status TEXT NOT NULL CHECK (new_status IN ('awaiting_delivery', 'received', 'in_custody', 'evaluated', 'accepted', 'rejected', 'return_pending', 'returned')),
  changed_by BIGINT REFERENCES public.app_users(id),
  reason TEXT CHECK (length(reason) <= 3000),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reception_status_history_reception_time_idx
  ON public.reception_status_history (reception_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS public.audit_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id BIGINT REFERENCES public.app_users(id),
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) BETWEEN 1 AND 120),
  resource_type TEXT NOT NULL CHECK (length(trim(resource_type)) BETWEEN 1 AND 120),
  resource_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.audit_events.metadata IS
  'Metadatos técnicos únicamente; no guardar documentos, correos, secretos ni cuerpos de solicitudes.';

CREATE INDEX IF NOT EXISTS audit_events_resource_time_idx
  ON public.audit_events (resource_type, resource_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_time_idx
  ON public.audit_events (occurred_at DESC);
