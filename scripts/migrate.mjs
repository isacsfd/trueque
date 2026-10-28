import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "@neondatabase/serverless";

const migrationDirectory = fileURLToPath(new URL("../db/migrations/", import.meta.url));
const localEnvPath = fileURLToPath(new URL("../.env", import.meta.url));

if (existsSync(localEnvPath)) {
  process.loadEnvFile(localEnvPath);
}

const applyRequested = process.argv.slice(2).includes("--apply");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--apply");

if (unknownArguments.length > 0) {
  console.error("Usage: node scripts/migrate.mjs [--apply]");
  process.exit(2);
}

const files = (await readdir(migrationDirectory))
  .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
  .sort();

const migrations = await Promise.all(
  files.map(async (file) => {
    const text = await readFile(new URL(`../db/migrations/${file}`, import.meta.url), "utf8");
    return {
      version: file.replace(/\.sql$/, ""),
      text,
      checksum: createHash("sha256").update(text).digest("hex"),
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
  console.log("Review the SQL, then use the explicit --apply command to apply it.");
  process.exit(0);
}

const connectionString = process.env.DATABASE_MIGRATION_URL?.trim();
const runtimeConnectionString = process.env.DATABASE_URL?.trim();

if (!connectionString) {
  console.error("DATABASE_MIGRATION_URL is required for --apply.");
  process.exit(2);
}

if (runtimeConnectionString && runtimeConnectionString === connectionString) {
  console.error("DATABASE_MIGRATION_URL must use a separate role from DATABASE_URL.");
  process.exit(2);
}

try {
  const parsedUrl = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol) || !parsedUrl.hostname) {
    throw new Error("Invalid URL.");
  }
} catch {
  console.error("DATABASE_MIGRATION_URL is invalid.");
  process.exit(2);
}

if (typeof WebSocket === "undefined") {
  console.error("Run migrations with Node.js 22 or newer.");
  process.exit(2);
}

const pool = new Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 5_000,
});

let client;

try {
  client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock($1, $2)", [408177, 1]);

  const ledgerCheck = await client.query(
    "SELECT to_regclass('public.schema_migrations') AS relation",
  );
  let ledgerExists = ledgerCheck.rows[0]?.relation !== null;

  if (!ledgerExists) {
    const existingObjects = await client.query(
      "SELECT count(*)::int AS object_count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname NOT LIKE 'pg_%' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')",
    );

    if (existingObjects.rows[0]?.object_count !== 0) {
      throw new Error("Untracked database objects found; manual review required.");
    }
  }

  const appliedMigrations = new Map();

  if (ledgerExists) {
    const result = await client.query(
      "SELECT version, checksum FROM public.schema_migrations ORDER BY version",
    );

    for (const row of result.rows) {
      appliedMigrations.set(row.version, row.checksum.trim());
    }
  }

  const pending = migrations.filter((migration) => {
    const appliedChecksum = appliedMigrations.get(migration.version);

    if (appliedChecksum && appliedChecksum !== migration.checksum) {
      throw new Error(`Checksum mismatch for ${migration.version}.`);
    }

    return !appliedChecksum;
  });

  if (pending.length === 0) {
    await client.query("COMMIT");
    console.log("Database schema is up to date; no migration was applied.");
  } else {
    for (const migration of pending) {
      await client.query(migration.text);

      const currentLedger = await client.query(
        "SELECT to_regclass('public.schema_migrations') AS relation",
      );
      ledgerExists = currentLedger.rows[0]?.relation !== null;

      if (!ledgerExists) {
        throw new Error("Migration did not create the schema migration ledger.");
      }

      await client.query(
        "INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)",
        [migration.version, migration.checksum],
      );
      appliedMigrations.set(migration.version, migration.checksum);
    }

    await client.query("COMMIT");
    console.log(`Applied ${pending.length} migration(s): ${pending.map(({ version }) => version).join(", ")}`);
  }
} catch (error) {
  if (client) {
    await client.query("ROLLBACK").catch(() => undefined);
  }

  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? ` (code ${error.code})`
      : "";
  const safeMessage =
    error instanceof Error &&
    (error.message.startsWith("Untracked database objects") ||
      error.message.startsWith("Checksum mismatch") ||
      error.message.startsWith("Migration did not create"))
      ? ` ${error.message}`
      : " Database operation failed; connection details were suppressed.";

  console.error(`Migration transaction rolled back.${safeMessage}${code}`);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end().catch(() => undefined);
}
