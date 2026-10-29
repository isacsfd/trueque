-- Sixth versioned migration. Additive audit tables for the institutional
-- inventory import. 0001-0005 are not edited.

CREATE TABLE public.inventory_import_batches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_filename TEXT NOT NULL CHECK (length(trim(source_filename)) BETWEEN 1 AND 500),
  source_sha256 BYTEA NOT NULL CHECK (octet_length(source_sha256) = 32),
  source_sheet TEXT NOT NULL CHECK (length(trim(source_sheet)) BETWEEN 1 AND 200),
  imported_by TEXT NOT NULL DEFAULT current_user,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  total_rows INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  imported_rows INTEGER NOT NULL DEFAULT 0 CHECK (imported_rows >= 0),
  reused_rows INTEGER NOT NULL DEFAULT 0 CHECK (reused_rows >= 0),
  skipped_rows INTEGER NOT NULL DEFAULT 0 CHECK (skipped_rows >= 0),
  rejected_rows INTEGER NOT NULL DEFAULT 0 CHECK (rejected_rows >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (source_sha256, source_sheet)
);

CREATE TABLE public.inventory_import_rows (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES public.inventory_import_batches(id),
  source_row INTEGER NOT NULL CHECK (source_row > 0),
  source_number TEXT,
  source_copy_number TEXT,
  status TEXT NOT NULL CHECK (status IN ('imported', 'reused', 'skipped', 'rejected')),
  bibliographic_record_id BIGINT REFERENCES public.bibliographic_records(id),
  copy_id BIGINT REFERENCES public.copies(id),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 3000),
  raw_row JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(raw_row) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (batch_id, source_row)
);

CREATE INDEX inventory_import_rows_batch_status_idx
  ON public.inventory_import_rows (batch_id, status);

-- A source row can only ever produce one institutional copy. This protects
-- re-runs even if the importer's inventory code changes later.
CREATE UNIQUE INDEX copies_inventory_import_reference_uidx
  ON public.copies (provenance_reference)
  WHERE provenance_type = 'institutional'
    AND provenance_reference LIKE 'inventory-import:%';

REVOKE ALL ON public.inventory_import_batches, public.inventory_import_rows
  FROM PUBLIC, iub_public_runtime, iub_admin_runtime;
GRANT SELECT ON public.inventory_import_batches, public.inventory_import_rows
  TO iub_admin_runtime;
