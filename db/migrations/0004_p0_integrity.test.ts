// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

const migrationUrl = new URL("./0001_initial_schema.sql", import.meta.url);
const correctiveUrl = new URL("./0002_corrective_schema.sql", import.meta.url);
const privilegesUrl = new URL("./0003_runtime_privileges.sql", import.meta.url);
const p0Url = new URL("./0004_p0_integrity.sql", import.meta.url);

describe("0004 P0 integrity migration", () => {
  let database: PGlite | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("applies additively and installs the P0 guards and compensation table", async () => {
    database = new PGlite();
    await database.exec(`
      CREATE ROLE iub_schema_migrator LOGIN NOINHERIT;
      CREATE ROLE iub_public_runtime LOGIN NOINHERIT;
      CREATE ROLE iub_admin_runtime LOGIN NOINHERIT;
      GRANT USAGE, CREATE ON SCHEMA public TO iub_schema_migrator;
      SET ROLE iub_schema_migrator;
    `);
    await database.exec(await readFile(migrationUrl, "utf8"));
    await database.exec(await readFile(correctiveUrl, "utf8"));
    await database.exec(await readFile(privilegesUrl, "utf8"));
    await database.exec(await readFile(p0Url, "utf8"));

    const relation = await database.query<{ relation: string | null }>(
      "SELECT to_regclass('public.ownership_transfer_reversals')::text AS relation",
    );
    expect(relation.rows[0]?.relation).toBe("ownership_transfer_reversals");

    const columns = await database.query<{ attname: string }>(
      `SELECT attname FROM pg_attribute
       WHERE attrelid = 'public.inventory_admissions'::regclass
         AND attname IN ('reversed_by', 'reversed_at')
       ORDER BY attname`,
    );
    expect(columns.rows.map((row) => row.attname)).toEqual(["reversed_at", "reversed_by"]);

    const checks = await database.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conname IN (
         'exchange_requests_status_check', 'exchanges_status_check',
         'receptions_status_check', 'inventory_admissions_status_check',
         'inventory_admissions_reversed_ck'
       )`,
    );
    const byName = new Map(checks.rows.map((row) => [row.conname, row.def]));
    expect(byName.get("exchange_requests_status_check")).toContain("cancellation_pending");
    expect(byName.get("exchanges_status_check")).toContain("cancellation_pending");
    expect(byName.get("receptions_status_check")).toContain("cancelled");
    expect(byName.get("inventory_admissions_status_check")).toContain("reversed");
    expect(byName.get("inventory_admissions_reversed_ck")).toContain("reversed");

    const guards = await database.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
       WHERE tgname IN (
         'inventory_admissions_request_guard',
         'ownership_transfers_request_guard',
         'copies_exchange_received_availability_guard',
         'ownership_transfer_reversals_immutable'
       ) ORDER BY tgname`,
    );
    expect(guards.rows.map((row) => row.tgname)).toEqual([
      "copies_exchange_received_availability_guard",
      "inventory_admissions_request_guard",
      "ownership_transfer_reversals_immutable",
      "ownership_transfers_request_guard",
    ]);

    const indexes = await database.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE indexname IN (
         'reservations_one_active_per_copy_uidx',
         'book_evaluations_one_final_per_reception_uidx'
       ) ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "book_evaluations_one_final_per_reception_uidx",
      "reservations_one_active_per_copy_uidx",
    ]);

    const privileges = await database.query<{
      admin_locks: boolean;
      admin_reads_reversals: boolean;
      public_cancels: boolean;
      public_reads_reversals: boolean;
    }>(
      `SELECT
         has_function_privilege('iub_admin_runtime', 'public.iub_lock_request(bigint)', 'EXECUTE') AS admin_locks,
         has_table_privilege('iub_admin_runtime', 'public.ownership_transfer_reversals', 'SELECT') AS admin_reads_reversals,
         has_function_privilege('iub_public_runtime', 'public.cancel_exchange(bigint,uuid,bigint,text)', 'EXECUTE') AS public_cancels,
         has_table_privilege('iub_public_runtime', 'public.ownership_transfer_reversals', 'SELECT') AS public_reads_reversals`,
    );
    expect(privileges.rows[0]).toEqual({
      admin_locks: false,
      admin_reads_reversals: true,
      public_cancels: false,
      public_reads_reversals: false,
    });
  }, 30_000);

  it("rolls back the whole 0004 migration when a statement fails", async () => {
    database = new PGlite();
    await database.exec(`
      CREATE ROLE iub_schema_migrator LOGIN NOINHERIT;
      CREATE ROLE iub_public_runtime LOGIN NOINHERIT;
      CREATE ROLE iub_admin_runtime LOGIN NOINHERIT;
      GRANT USAGE, CREATE ON SCHEMA public TO iub_schema_migrator;
      SET ROLE iub_schema_migrator;
    `);
    await database.exec(await readFile(migrationUrl, "utf8"));
    await database.exec(await readFile(correctiveUrl, "utf8"));
    await database.exec(await readFile(privilegesUrl, "utf8"));
    await database.exec("BEGIN");
    await database.exec(await readFile(p0Url, "utf8"));
    await database.exec("ROLLBACK");

    const relation = await database.query<{ relation: string | null }>(
      "SELECT to_regclass('public.ownership_transfer_reversals')::text AS relation",
    );
    expect(relation.rows[0]?.relation).toBeNull();

    const routine = await database.query<{ routine: string | null }>(
      "SELECT to_regprocedure('public.iub_lock_request(bigint)')::text AS routine",
    );
    expect(routine.rows[0]?.routine).toBeNull();
  }, 30_000);
});
