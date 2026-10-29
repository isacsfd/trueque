/**
 * SQL checksums must not depend on the machine that checked the repository out.
 * The canonical form is UTF-8 without a BOM and with LF line endings. Nothing
 * else is changed: comments, whitespace and SQL text stay byte-for-byte equal.
 */
export function canonicalizeSql(text) {
  if (typeof text !== "string") {
    throw new TypeError("SQL content must be a string.");
  }

  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export function parseDatabaseRole(connectionString) {
  let parsed;

  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("A database connection URL is invalid.");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.username) {
    throw new Error("A PostgreSQL URL with a role is required.");
  }

  try {
    return decodeURIComponent(parsed.username);
  } catch {
    throw new Error("A database URL contains an invalid role encoding.");
  }
}

export function parseDatabaseTarget(connectionString) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("A database connection URL is invalid.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("A PostgreSQL connection target is required.");
  }

  const host = parsed.hostname.toLowerCase().replace(/-pooler(?=\.)/, "");
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  return `${host}:${parsed.port || "5432"}/${database}`;
}

export function validateRoleSeparation({
  expectedMigrationRole,
  actualMigrationRole,
  runtimeRoles,
}) {
  if (!expectedMigrationRole || !actualMigrationRole || expectedMigrationRole !== actualMigrationRole) {
    throw new Error("Connected migration role does not match DATABASE_MIGRATION_ROLE.");
  }
  if (expectedMigrationRole !== "iub_schema_migrator") {
    throw new Error("DATABASE_MIGRATION_ROLE must be iub_schema_migrator.");
  }

  if (!runtimeRoles.length || runtimeRoles.some((role) => !role)) {
    throw new Error("At least one runtime connection role is required.");
  }

  if (runtimeRoles.some((role) => role === actualMigrationRole)) {
    throw new Error("Migration and runtime connections must use different PostgreSQL roles.");
  }

  if (new Set(runtimeRoles).size !== runtimeRoles.length) {
    throw new Error("Public and administrative runtime roles must be distinct.");
  }
  if (runtimeRoles.length !== 2 || runtimeRoles[0] !== "iub_public_runtime" || runtimeRoles[1] !== "iub_admin_runtime") {
    throw new Error("Runtime URLs must use iub_public_runtime and iub_admin_runtime in that order.");
  }
}

export function validateDatabaseTargetSeparation(migrationTarget, runtimeTargets) {
  if (!migrationTarget || runtimeTargets.length === 0 || runtimeTargets.some((target) => target !== migrationTarget)) {
    throw new Error("Migration and runtime URLs must point to the same database target.");
  }
}

export function pendingMigrations(localMigrations, appliedRows) {
  const localByVersion = new Map();

  for (const migration of localMigrations) {
    if (localByVersion.has(migration.version)) {
      throw new Error("Duplicate migration version in local files.");
    }
    localByVersion.set(migration.version, migration);
  }

  const appliedByVersion = new Map();
  for (const row of appliedRows) {
    if (!localByVersion.has(row.version)) {
      throw new Error("Database ledger contains an unknown migration version.");
    }
    if (appliedByVersion.has(row.version)) {
      throw new Error("Database ledger contains a duplicate migration version.");
    }
    const local = localByVersion.get(row.version);
    if (local.checksum !== row.checksum.trim()) {
      throw new Error(`Checksum mismatch for migration ${row.version}.`);
    }
    appliedByVersion.set(row.version, row.checksum.trim());
  }

  const ordered = [...localMigrations].sort((left, right) => left.version.localeCompare(right.version));
  let foundPending = false;
  const pending = [];

  for (const migration of ordered) {
    if (appliedByVersion.has(migration.version)) {
      if (foundPending) {
        throw new Error("Applied migrations must be a contiguous prefix of local versions.");
      }
    } else {
      foundPending = true;
      pending.push(migration);
    }
  }

  return pending;
}

export function compareObjectManifest(actualObjects, expectedObjects) {
  const key = ({ object_type, object_name }) => `${object_type}\u0000${object_name}`;
  const actual = new Set(actualObjects.map(key));
  const expected = new Set(expectedObjects.map(key));

  return {
    unexpected: actualObjects.filter((object) => !expected.has(key(object))),
    missing: expectedObjects.filter((object) => !actual.has(key(object))),
  };
}

/**
 * Manifest rows that no longer match a live object. A reviewed migration may
 * replace an object (for example a superseded index), so the ledger has to
 * forget the stale row instead of failing the next run.
 */
export function staleManifestEntries(actualObjects, manifestRows) {
  const key = ({ object_type, object_name }) => `${object_type}\u0000${object_name}`;
  const actual = new Set(actualObjects.map(key));
  return manifestRows.filter((row) => !actual.has(key(row)));
}

function manifestKey({ object_type, object_name }) {
  return `${object_type}\u0000${object_name}`;
}

export function dedupeObjects(objects) {
  const seen = new Set();
  const unique = [];

  for (const object of objects) {
    const key = manifestKey(object);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ object_type: object.object_type, object_name: object.object_name });
  }

  return unique;
}

/**
 * Computes the manifest reconciliation without touching the database. Objects
 * captured before the manifest existed keep their original migration
 * attribution; objects introduced by the current migration get its version.
 */
export function planManifestRefresh(
  actualObjects,
  manifestRows,
  { version, baselineObjects = [], baselineVersion = null } = {},
) {
  if (!version) {
    throw new Error("A baseline version is required to refresh the manifest.");
  }

  const baseline = dedupeObjects(baselineObjects ?? []);
  if (baseline.length > 0 && !baselineVersion) {
    throw new Error("A baseline version is required when baseline objects are present.");
  }

  const actual = dedupeObjects(actualObjects);
  const existing = new Set(manifestRows.map(manifestKey));
  const baselineKeys = new Set(baseline.map(manifestKey));

  return {
    stale: staleManifestEntries(actual, manifestRows),
    inserts: actual
      .filter((object) => !existing.has(manifestKey(object)))
      .map((object) => ({
        object_type: object.object_type,
        object_name: object.object_name,
        introduced_by: baselineKeys.has(manifestKey(object)) ? baselineVersion : version,
      })),
  };
}

const RESERVED_PRIVILEGED_ROLES = new Set([
  "pg_database_owner",
  "pg_read_all_data",
  "pg_write_all_data",
  "neon_superuser",
]);

export function validateRoleMemberships({
  memberships,
  migrationRole,
  runtimeRoles,
  databaseOwner = null,
}) {
  const runtime = new Set(runtimeRoles);

  for (const membership of memberships) {
    if (runtime.has(membership.member_name)) {
      throw new Error("A runtime role has a role membership that is not allowed.");
    }
    if (runtime.has(membership.granted_role) && membership.member_name !== databaseOwner) {
      throw new Error("A runtime role has been granted to another role.");
    }
    if (membership.member_name === migrationRole
      && (membership.granted_super
        || membership.granted_createrole
        || membership.granted_createdb
        || membership.granted_bypassrls
        || RESERVED_PRIVILEGED_ROLES.has(membership.granted_role))) {
      throw new Error("The migration role has a privileged role membership.");
    }
  }
}

const PUBLIC_RUNTIME_FUNCTIONS = new Set([
  "reserve_copy(bigint,bigint,bytea,uuid)",
  "create_exchange_request(text,jsonb,uuid)",
  "get_request_status(text,bytea)",
  "create_offered_book_submission(bigint,bytea,text,text,text,text,text,text,text,text,uuid)",
  "update_offered_book_submission(bigint,bytea,text,text,text,text,text,text,text,text)",
  "register_offered_book_evidence(bigint,bytea,text,text,text,integer,bytea,integer,integer,uuid)",
  "delete_offered_book_evidence(bigint,bytea)",
  "submit_offered_book_submission(bigint,bytea,text,jsonb,uuid)",
  "resubmit_offered_book_submission(bigint,bytea,uuid)",
  "get_offered_book_submission(bigint,bytea)",
  "get_offered_book_evidence(bigint,bytea)",
]);

const ADMIN_RUNTIME_FUNCTIONS = new Set([
  "set_request_status(bigint,text,bigint,text)",
  "get_participant_contact(bigint,bigint)",
  "withdraw_privacy_consent(bigint,bigint,bytea,uuid)",
  "set_reservation_policy(integer,bigint)",
  "expire_reservations(bigint,integer)",
  "plan_exchange(bigint,text,uuid,bigint)",
  "schedule_delivery(bigint,text,timestamp with time zone,uuid,bigint)",
  "confirm_delivery(bigint,bigint,text,text,uuid)",
  "place_reception_in_custody(bigint,bigint,text,text,text,uuid)",
  "evaluate_reception(bigint,bigint,text,text,text,uuid,text)",
  "request_reception_return(bigint,bigint,text)",
  "record_cataloging_validation(bigint,bigint,bigint,uuid)",
  "authorize_cataloging(bigint,bigint,uuid)",
  "authorize_inventory_admission(bigint,bigint,uuid)",
  "admit_received_book(bigint,text,text,bigint)",
  "enable_received_copy(bigint,bigint)",
  "start_exchange(bigint,bigint)",
  "complete_exchange(bigint,uuid,bigint)",
  "cancel_exchange(bigint,uuid,bigint,text)",
  "prepare_cataloging(bigint,text,text,text,text,bigint,uuid)",
  "review_offered_book_submission(bigint,bigint,text,text,text,uuid)",
  "store_inventory_batch(text,bytea,integer,text,integer,jsonb,jsonb,bigint,uuid,text,text)",
  "confirm_inventory_batch(bigint,bigint,uuid)",
  "cancel_inventory_batch(bigint,bigint,uuid)",
  "assert_actor_permission(bigint,text)",
  "admin_list_accounts(bigint)",
  "admin_create_account(bigint,text,text,text)",
  "admin_set_account_active(bigint,bigint,boolean)",
  "admin_assign_role(bigint,bigint,bigint)",
  "admin_remove_role(bigint,bigint,bigint)",
]);

export function normalizeFunctionSignature(signature) {
  return signature
    .replace(/^public\./, "")
    .replace(/\s*,\s*/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

export function unexpectedRuntimeFunctions(role, signatures) {
  const allowed = role === "iub_public_runtime"
    ? PUBLIC_RUNTIME_FUNCTIONS
    : role === "iub_admin_runtime"
      ? ADMIN_RUNTIME_FUNCTIONS
      : new Set();

  return signatures
    .map(normalizeFunctionSignature)
    .filter((signature) => !allowed.has(signature));
}
