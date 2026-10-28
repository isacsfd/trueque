import { neon } from "@neondatabase/serverless";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const localEnvPath = fileURLToPath(new URL("../.env", import.meta.url));

if (existsSync(localEnvPath)) {
  process.loadEnvFile(localEnvPath);
}

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = neon(connectionString);

try {
  const ping = await sql.query("SELECT 1::int AS ok");
  const schemas = await sql.query(
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ($1, $2) AND schema_name NOT LIKE $3 ORDER BY schema_name",
    ["pg_catalog", "information_schema", "pg_%"],
  );
  const relations = await sql.query(
    "SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ($1, $2, $3) AND n.nspname NOT LIKE $4 AND c.relkind IN ($5, $6, $7, $8, $9, $10) ORDER BY n.nspname, c.relname",
    ["pg_catalog", "information_schema", "pg_toast", "pg_%", "r", "p", "v", "m", "S", "f"],
  );
  const tables = await sql.query(
    "SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = $1 AND table_schema NOT IN ($2, $3) ORDER BY table_schema, table_name",
    ["BASE TABLE", "pg_catalog", "information_schema"],
  );
  const columns = await sql.query(
    "SELECT table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema NOT IN ($1, $2) ORDER BY table_schema, table_name, ordinal_position",
    ["pg_catalog", "information_schema"],
  );
  const constraints = await sql.query(
    "SELECT n.nspname AS schema, r.relname AS table, c.conname AS name, c.contype AS type, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname NOT IN ($1, $2, $3) AND n.nspname NOT LIKE $4 ORDER BY n.nspname, r.relname, c.conname",
    ["pg_catalog", "information_schema", "pg_toast", "pg_%"],
  );
  const indexes = await sql.query(
    "SELECT schemaname AS schema, tablename AS table, indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname NOT IN ($1, $2, $3) AND schemaname NOT LIKE $4 ORDER BY schemaname, tablename, indexname",
    ["pg_catalog", "information_schema", "pg_toast", "pg_%"],
  );

  console.log(
    JSON.stringify(
      {
        connection: ping[0]?.ok === 1 ? "ok (read-only SELECT 1)" : "unexpected result",
        schemas,
        relations,
        tables,
        columns,
        constraints,
        indexes,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      connection: "failed",
      code: typeof error === "object" && error && "code" in error ? error.code : "unknown",
    }),
  );
  process.exitCode = 1;
}
