import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  canonicalizeSql,
  dedupeObjects,
  parseDatabaseTarget,
  parseDatabaseRole,
  pendingMigrations,
  unexpectedRuntimeFunctions,
  validateDatabaseTargetSeparation,
  validateRoleMemberships,
  validateRoleSeparation,
} from "./migration-safety.mjs";
import {
  assertManifest,
  assertManifestShape,
  getPublicObjects,
  manifestExists,
  refreshManifest,
} from "./schema-manifest.mjs";

const migrationDirectory = fileURLToPath(new URL("../db/migrations/", import.meta.url));
const localEnvPath = fileURLToPath(new URL("../.env", import.meta.url));

if (existsSync(localEnvPath)) {
  try {
    process.loadEnvFile(localEnvPath);
  } catch {
    console.error("Could not load the local environment file; details suppressed.");
    process.exit(2);
  }
}

const args = process.argv.slice(2);
const applyRequested = args.includes("--apply");
if (args.some((argument) => argument !== "--apply")) {
  console.error("Usage: node scripts/migrate.mjs [--apply]");
  process.exit(2);
}

const files = (await readdir(migrationDirectory))
  .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
  .sort();
const migrations = await Promise.all(
  files.map(async (file) => {
    const rawText = await readFile(new URL(`../db/migrations/${file}`, import.meta.url), "utf8");
    const text = canonicalizeSql(rawText);
    return {
      version: file.replace(/\.sql$/, ""),
      text,
      checksum: createHash("sha256").update(text, "utf8").digest("hex"),
    };
  }),
);

if (migrations.length === 0) {
  console.log("No versioned SQL migrations found.");
  process.exit(0);
}

if (!applyRequested) {
  console.log("Migration plan only; no database connection was opened.");
  for (const migration of migrations) {
    console.log(`${migration.version}  sha256:${migration.checksum}`);
  }
  console.log("Review the SQL and role setup before using the explicit --apply command.");
  process.exit(0);
}

const migrationUrl = process.env.DATABASE_MIGRATION_URL?.trim();
const expectedMigrationRole = process.env.DATABASE_MIGRATION_ROLE?.trim();
const runtimeUrls = [process.env.DATABASE_URL?.trim(), process.env.DATABASE_ADMIN_URL?.trim()];

if (!migrationUrl || !expectedMigrationRole || runtimeUrls.some((value) => !value)) {
  console.error("DATABASE_URL, DATABASE_ADMIN_URL, DATABASE_MIGRATION_URL, and DATABASE_MIGRATION_ROLE are required for --apply.");
  process.exit(2);
}

let migrationUsername;
let runtimeUsernames;
try {
  migrationUsername = parseDatabaseRole(migrationUrl);
  runtimeUsernames = runtimeUrls.map((url) => parseDatabaseRole(url));
  validateRoleSeparation({
    expectedMigrationRole,
    actualMigrationRole: migrationUsername,
    runtimeRoles: runtimeUsernames,
  });
  validateDatabaseTargetSeparation(
    parseDatabaseTarget(migrationUrl),
    runtimeUrls.map((url) => parseDatabaseTarget(url)),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Database role separation validation failed.");
  process.exit(2);
}

if (typeof WebSocket === "undefined" && (process.env.DATABASE_MIGRATION_DRIVER?.trim() ?? "neon") !== "pg") {
  console.error("Run migrations with Node.js 22 or newer.");
  process.exit(2);
}

const migrationDriver = process.env.DATABASE_MIGRATION_DRIVER?.trim() ?? "neon";
let Pool;
if (migrationDriver === "pg") {
  ({ Pool } = await import("pg"));
} else if (migrationDriver === "neon") {
  ({ Pool } = await import("@neondatabase/serverless"));
} else {
  console.error("DATABASE_MIGRATION_DRIVER must be neon or pg.");
  process.exit(2);
}

const pool = new Pool({
  connectionString: migrationUrl,
  max: 1,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 5_000,
});
let client;

function debugStage(name) {
  if (process.env.MIGRATION_DEBUG_STAGE === "1") {
    console.error(`[migration-stage] ${name}`);
  }
}

async function assertNoUnexpectedSchemas(connection) {
  const result = await connection.query(`
    SELECT count(*)::int AS count
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'public')
      AND schema_name NOT LIKE 'pg_%'
  `);
  if (result.rows[0]?.count !== 0) {
    throw new Error("Unexpected user schemas exist outside public; manual review required.");
  }
}

async function assertNoPublicWrites(connection, migrationRole, runtimeRoles) {
  const tableAcl = await connection.query(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END, c.relowner))) acl
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND acl.grantee = 0
    ) AS has_public_write
  `);
  const functionAcl = await connection.query(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      WHERE n.nspname = 'public' AND acl.grantee = 0
    ) AS has_public_execute
  `);
  const defaultAcl = await connection.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM pg_default_acl d
         CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
         WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = $1)
            AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
            AND acl.privilege_type IS NOT NULL
           AND acl.grantee = 0
       ) AS has_public_default_access,
       EXISTS (
         SELECT 1 FROM pg_default_acl d
         CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
         JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = $1)
            AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
            AND grantee.rolname = ANY($2::text[])
       ) AS has_runtime_default_access`,
    [migrationRole, runtimeRoles],
  );
  if (tableAcl.rows[0]?.has_public_write || functionAcl.rows[0]?.has_public_execute || defaultAcl.rows[0]?.has_public_default_access) {
    throw new Error("PUBLIC has privileges on objects/defaults in public; refusing to migrate.");
  }
  if (defaultAcl.rows[0]?.has_runtime_default_access) {
    throw new Error("A runtime role has default privileges in schema public; refusing to migrate.");
  }
}

async function verifyRoleAccounts(connection, migrationRole, runtimeRoles) {
  const roles = [...new Set([migrationRole, ...runtimeRoles])];
  const result = await connection.query(
    `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
            rolinherit, rolbypassrls,
            has_schema_privilege(rolname, 'public', 'CREATE') AS can_create_schema,
            has_schema_privilege(rolname, 'public', 'USAGE') AS can_use_schema,
            has_database_privilege(rolname, current_database(), 'CREATE') AS can_create_database,
            has_database_privilege(rolname, current_database(), 'CONNECT') AS can_connect
     FROM pg_roles WHERE rolname = ANY($1::text[])`,
    [roles],
  );
  const byName = new Map(result.rows.map((row) => [row.rolname, row]));

  for (const roleName of roles) {
    const role = byName.get(roleName);
    if (!role || !role.rolcanlogin || role.rolsuper || role.rolcreatedb || role.rolcreaterole
      || role.rolreplication || role.rolbypassrls || !role.can_connect) {
      throw new Error("A migration/runtime role is missing or has excessive cluster privileges.");
    }
    if (role.rolinherit) {
      throw new Error("A migration/runtime role must be NOINHERIT.");
    }
  }

  const memberships = await connection.query(
    `SELECT member.rolname AS member_name, granted.rolname AS granted_role,
            granted.rolsuper AS granted_super, granted.rolcreaterole AS granted_createrole,
            granted.rolcreatedb AS granted_createdb, granted.rolbypassrls AS granted_bypassrls
     FROM pg_auth_members am
     JOIN pg_roles member ON member.oid = am.member
     JOIN pg_roles granted ON granted.oid = am.roleid
     WHERE member.rolname = ANY($1::text[]) OR granted.rolname = ANY($1::text[])`,
    [roles],
  );
  const owner = await connection.query(
    `SELECT r.rolname
     FROM pg_database d
     JOIN pg_roles r ON r.oid = d.datdba
     WHERE d.datname = current_database()`,
  );
  validateRoleMemberships({
    memberships: memberships.rows,
    migrationRole,
    runtimeRoles,
    databaseOwner: owner.rows[0]?.rolname ?? null,
  });

  const migrationRoleInfo = byName.get(migrationRole);
  if (!migrationRoleInfo.can_create_schema || !migrationRoleInfo.can_use_schema) {
    throw new Error("The migration role lacks CREATE/USAGE on schema public.");
  }
  if (migrationRoleInfo.can_create_database) {
    throw new Error("The migration role must not have CREATE on databases.");
  }
  if (runtimeRoles.some((role) => byName.get(role)?.can_create_schema || byName.get(role)?.can_create_database)) {
    throw new Error("A runtime role has DDL privileges.");
  }
}

async function verifyRolePrivileges(connection, migrationRole, runtimeRoles) {
  for (const role of runtimeRoles) {
    const tableWrite = await connection.query(
      `SELECT c.relname, p.privilege
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN (VALUES
         ('r', 'INSERT'), ('r', 'UPDATE'), ('r', 'DELETE'), ('r', 'TRUNCATE'), ('r', 'REFERENCES'), ('r', 'TRIGGER'),
         ('p', 'INSERT'), ('p', 'UPDATE'), ('p', 'DELETE'), ('p', 'TRUNCATE'), ('p', 'REFERENCES'), ('p', 'TRIGGER'),
         ('v', 'INSERT'), ('v', 'UPDATE'), ('v', 'DELETE'),
         ('f', 'INSERT'), ('f', 'UPDATE'), ('f', 'DELETE')
       ) AS p(relkind, privilege) ON p.relkind = c.relkind::text
       WHERE n.nspname = 'public' AND has_table_privilege($1, c.oid, p.privilege)
       LIMIT 1`,
      [role],
    );
    if (tableWrite.rows.length > 0) {
      throw new Error("A runtime role has effective table mutation privileges; use reviewed functions instead.");
    }

    const columnWrite = await connection.query(
      `SELECT c.relname, a.attname, p.privilege
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN (VALUES
         ('r', 'INSERT'), ('r', 'UPDATE'), ('r', 'REFERENCES'),
         ('p', 'INSERT'), ('p', 'UPDATE'), ('p', 'REFERENCES'),
         ('v', 'INSERT'), ('v', 'UPDATE'),
         ('f', 'INSERT'), ('f', 'UPDATE'), ('f', 'REFERENCES')
       ) AS p(relkind, privilege) ON p.relkind = c.relkind::text
       WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
         AND has_column_privilege($1, c.oid, a.attnum, p.privilege)
       LIMIT 1`,
      [role],
    );
    if (columnWrite.rows.length > 0) {
      throw new Error("A runtime role has effective column mutation privileges; use reviewed functions instead.");
    }

    const sequencePrivilege = await connection.query(
      `SELECT c.relname, p.privilege
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) AS p(privilege)
       WHERE n.nspname = 'public' AND c.relkind = 'S'
         AND has_sequence_privilege($1, c.oid, p.privilege)
       LIMIT 1`,
      [role],
    );
    if (sequencePrivilege.rows.length > 0) {
      throw new Error("A runtime role has sequence privileges; use reviewed functions instead.");
    }

    if (role === "iub_public_runtime") {
      const catalogueReads = await connection.query(
        `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND c.relname <> 'available_catalog'
           AND has_table_privilege($1, c.oid, 'SELECT')
         LIMIT 1`,
        [role],
      );
      if (catalogueReads.rows.length > 0) {
        throw new Error("A runtime role has SELECT on a non-catalogue relation.");
      }
    }

    const functions = await connection.query(
      `SELECT replace(p.oid::regprocedure::text, 'public.', '') AS signature
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
         AND has_function_privilege($1, p.oid, 'EXECUTE')`,
      [role],
    );
    if (unexpectedRuntimeFunctions(role, functions.rows.map((row) => row.signature)).length > 0) {
      throw new Error("A runtime role has EXECUTE on an unreviewed function.");
    }
  }

  const ownership = await connection.query(
    `SELECT kind, name FROM (
       SELECT 'relation'::text AS kind, c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'i', 'I')
         AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = $1)
       UNION ALL
       SELECT 'routine'::text, p.proname
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proowner <> (SELECT oid FROM pg_roles WHERE rolname = $1)
       UNION ALL
       SELECT 'type'::text, t.typname
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typtype IN ('c', 'd', 'e', 'r')
         AND t.typowner <> (SELECT oid FROM pg_roles WHERE rolname = $1)
     ) owned
     LIMIT 1`,
    [migrationRole],
  );
  if (ownership.rows.length > 0) {
    throw new Error("An object in schema public is not owned by the migration role; manual review required.");
  }

  const defaultGrants = await connection.query(
    `SELECT 1
     FROM pg_default_acl d
     CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
     JOIN pg_roles grantee ON grantee.oid = acl.grantee
     WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = $1)
       AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
       AND grantee.rolname = ANY($2::text[])
     LIMIT 1`,
    [migrationRole, runtimeRoles],
  );
  if (defaultGrants.rows.length > 0) {
    throw new Error("A runtime role has default privileges in schema public; refusing to migrate.");
  }

  const grants = await connection.query(
    `SELECT
       has_schema_privilege($1, 'public', 'USAGE') AS public_uses_schema,
       has_schema_privilege($2, 'public', 'USAGE') AS admin_uses_schema,
       has_table_privilege($1, 'public.available_catalog', 'SELECT') AS public_reads_catalog,
       has_table_privilege($1, 'public.participants', 'SELECT') AS public_reads_participants,
       has_table_privilege($1, 'public.exchange_requests', 'SELECT') AS public_reads_requests,
       has_table_privilege($1, 'public.state_history', 'SELECT') AS public_reads_history,
       has_function_privilege($1, 'public.reserve_copy(bigint,bigint,bytea,uuid)', 'EXECUTE') AS public_can_reserve,
       has_function_privilege($1, 'public.complete_exchange(bigint,uuid,bigint)', 'EXECUTE') AS public_can_complete,
       has_function_privilege($1, 'public.set_request_status(bigint,text,bigint,text)', 'EXECUTE') AS public_can_transition,
       has_table_privilege($2, 'public.participants', 'SELECT') AS admin_reads_participants,
       has_function_privilege($2, 'public.get_participant_contact(bigint,bigint)', 'EXECUTE') AS admin_can_read_contact,
       has_function_privilege($2, 'public.complete_exchange(bigint,uuid,bigint)', 'EXECUTE') AS admin_can_complete,
       has_function_privilege($2, 'public.cancel_exchange(bigint,uuid,bigint,text)', 'EXECUTE') AS admin_can_cancel,
       has_table_privilege($2, 'public.state_history', 'UPDATE') AS admin_can_edit_history`,
    runtimeRoles,
  );
  const grant = grants.rows[0];
  if (!grant || !grant.public_uses_schema || !grant.admin_uses_schema || !grant.public_reads_catalog
    || grant.public_reads_participants || grant.public_reads_requests || grant.public_reads_history
    || !grant.public_can_reserve || grant.public_can_complete || grant.public_can_transition
    || grant.admin_reads_participants || !grant.admin_can_read_contact
    || !grant.admin_can_complete || !grant.admin_can_cancel || grant.admin_can_edit_history) {
    throw new Error("Runtime role grants do not match the reviewed public/admin access policy.");
  }
}

async function assertLedgerShape(connection) {
  const columns = await connection.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'schema_migrations' ORDER BY ordinal_position`,
  );
  const actual = columns.rows.map((row) => `${row.column_name}:${row.data_type}`);
  const expected = ["version:text", "checksum:character", "applied_at:timestamp with time zone"];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("The migration ledger has an unexpected structure; manual review required.");
  }
}

try {
  client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock($1, $2)", [408177, 1]);

  const identity = await client.query("SELECT current_user AS role_name");
  const actualMigrationRole = identity.rows[0]?.role_name;
  validateRoleSeparation({
    expectedMigrationRole,
    actualMigrationRole,
    runtimeRoles: runtimeUsernames,
  });
  await verifyRoleAccounts(client, actualMigrationRole, runtimeUsernames);
  await assertNoPublicWrites(client, actualMigrationRole, runtimeUsernames);
  await assertNoUnexpectedSchemas(client);
  debugStage("preflight-complete");

  const ledgerCheck = await client.query("SELECT to_regclass('public.schema_migrations') AS relation");
  const ledgerExists = Boolean(ledgerCheck.rows[0]?.relation);
  let appliedRows = [];
  let baselineObjects = [];
  let baselineVersion = null;

  if (!ledgerExists) {
    const existingObjects = await getPublicObjects(client);
    if (existingObjects.length !== 0) {
      throw new Error("Untracked database objects found; manual review required.");
    }
  } else {
    await assertLedgerShape(client);
    const result = await client.query(
      "SELECT version, checksum FROM public.schema_migrations ORDER BY version",
    );
    appliedRows = result.rows;
    if (appliedRows.length === 0) {
      throw new Error("An empty migration ledger already exists; manual review required.");
    }
    if (!(await manifestExists(client))) {
      throw new Error("Applied migrations have no schema-object manifest; manual review required.");
    }
    await assertManifestShape(client);
    await assertManifest(client);
  }

  const pending = pendingMigrations(migrations, appliedRows);
  if (pending.length === 0) {
    await verifyRolePrivileges(client, actualMigrationRole, runtimeUsernames);
    await assertNoPublicWrites(client, actualMigrationRole, runtimeUsernames);
    await client.query("COMMIT");
    console.log("Database schema is up to date; no migration was applied.");
  } else {
    for (const migration of pending) {
      debugStage(`apply:${migration.version}`);
      await client.query(migration.text);
      await client.query(
        "INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)",
        [migration.version, migration.checksum],
      );
      debugStage(`applied:${migration.version}`);

      if (!(await manifestExists(client))) {
        if (baselineVersion === null) {
          baselineObjects = dedupeObjects(await getPublicObjects(client));
          baselineVersion = migration.version;
        }
        continue;
      }

      await assertManifestShape(client);
      await refreshManifest(client, migration.version, baselineObjects, baselineVersion);
      debugStage(`manifest:${migration.version}`);
      baselineObjects = [];
      baselineVersion = null;
    }

    if (!(await manifestExists(client))) {
      throw new Error("No migration created the schema object manifest; manual review required.");
    }

    await verifyRolePrivileges(client, actualMigrationRole, runtimeUsernames);
    debugStage("privileges-verified");
    await assertNoPublicWrites(client, actualMigrationRole, runtimeUsernames);
    await client.query("COMMIT");
    console.log(`Applied ${pending.length} migration(s): ${pending.map(({ version }) => version).join(", ")}`);
  }
} catch (error) {
  if (client) await client.query("ROLLBACK").catch(() => undefined);
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)
      ? ` (SQLSTATE ${error.code})`
      : "";
  const safeMessage =
    error instanceof Error && /^(Database ledger|Schema object manifest|The schema object manifest|Untracked database objects|An empty migration ledger|The migration role|A runtime role|A migration\/runtime role|PUBLIC has|Applied migrations|No migration created|Unknown migration|Checksum mismatch|Duplicate migration|Migration and runtime|Connected migration|At least one runtime|Public and administrative|An object in schema public|A baseline version)/.test(error.message)
      ? ` ${error.message}`
      : " Database operation failed; connection details were suppressed.";
  console.error(`Migration transaction rolled back.${safeMessage}${code}`);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end().catch(() => undefined);
}
