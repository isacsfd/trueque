// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertManifest,
  assertManifestShape,
  getPublicObjects,
  manifestExists,
  refreshManifest,
} from "./schema-manifest.mjs";

const readMigration = (file: string) =>
  readFile(resolve(process.cwd(), "db/migrations", file), "utf8");

describe("schema object manifest bootstrap", () => {
  let database: PGlite | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("captures the 0001 baseline before the manifest exists and attributes it correctly", async () => {
    database = new PGlite();
    await database.exec(await readMigration("0001_initial_schema.sql"));

    expect(await manifestExists(database)).toBe(false);
    const baseline = await getPublicObjects(database);
    expect(baseline.length).toBeGreaterThan(0);

    await database.exec(await readMigration("0002_corrective_schema.sql"));

    expect(await manifestExists(database)).toBe(true);
    await assertManifestShape(database);
    await refreshManifest(database, "0002_corrective_schema", baseline, "0001_initial_schema");
    await assertManifest(database);

    const ledger = await database.query<{ introduced_by: string }>(
      `SELECT introduced_by FROM public.schema_object_manifest
       WHERE object_type = 'relation' AND object_name = 'r:schema_migrations'`,
    );
    expect(ledger.rows[0]?.introduced_by).toBe("0001_initial_schema");

    const manifest = await database.query<{ introduced_by: string }>(
      `SELECT introduced_by FROM public.schema_object_manifest
       WHERE object_type = 'relation' AND object_name = 'r:schema_object_manifest'`,
    );
    expect(manifest.rows[0]?.introduced_by).toBe("0002_corrective_schema");
  }, 30_000);

  it("keeps original attribution and removes stale rows on a later migration", async () => {
    database = new PGlite();
    await database.exec(await readMigration("0001_initial_schema.sql"));
    const baseline = await getPublicObjects(database);
    await database.exec(await readMigration("0002_corrective_schema.sql"));
    await refreshManifest(database, "0002_corrective_schema", baseline, "0001_initial_schema");

    await database.exec(
      `INSERT INTO public.schema_object_manifest (object_type, object_name, introduced_by)
       VALUES ('relation', 'r:stale_object', '0002_corrective_schema')`,
    );
    await expect(assertManifest(database)).rejects.toThrow(/manifest differs/i);

    await refreshManifest(database, "0003_runtime_privileges");
    await assertManifest(database);

    const stale = await database.query(
      `SELECT 1 FROM public.schema_object_manifest
       WHERE object_type = 'relation' AND object_name = 'r:stale_object'`,
    );
    expect(stale.rows).toHaveLength(0);

    const ledger = await database.query<{ introduced_by: string }>(
      `SELECT introduced_by FROM public.schema_object_manifest
       WHERE object_type = 'relation' AND object_name = 'r:schema_migrations'`,
    );
    expect(ledger.rows[0]?.introduced_by).toBe("0001_initial_schema");
  }, 30_000);

  it("rejects a manifest with an unexpected structure", async () => {
    database = new PGlite();
    await database.exec(`
      CREATE TABLE public.schema_object_manifest (
        object_type TEXT NOT NULL,
        object_name TEXT NOT NULL
      );
    `);

    await expect(assertManifestShape(database)).rejects.toThrow(/unexpected structure/i);
  }, 15_000);

  it("tracks the objects introduced by 0004 on a database with migration history", async () => {
    database = new PGlite();
    await database.exec(`
      CREATE ROLE iub_schema_migrator LOGIN NOINHERIT;
      CREATE ROLE iub_public_runtime LOGIN NOINHERIT;
      CREATE ROLE iub_admin_runtime LOGIN NOINHERIT;
      GRANT USAGE, CREATE ON SCHEMA public TO iub_schema_migrator;
      SET ROLE iub_schema_migrator;
    `);

    await database.exec(await readMigration("0001_initial_schema.sql"));
    const baseline = await getPublicObjects(database);

    await database.exec(await readMigration("0002_corrective_schema.sql"));
    await refreshManifest(database, "0002_corrective_schema", baseline, "0001_initial_schema");

    await database.exec(await readMigration("0003_runtime_privileges.sql"));
    await refreshManifest(database, "0003_runtime_privileges");

    await database.exec(await readMigration("0004_p0_integrity.sql"));
    await refreshManifest(database, "0004_p0_integrity");

    await database.exec(await readMigration("0005_participant_api.sql"));
    await refreshManifest(database, "0005_participant_api");

    await database.exec(await readMigration("0006_inventory_import.sql"));
    await refreshManifest(database, "0006_inventory_import");
    await assertManifest(database);

    const p0Objects = await database.query<{ object_name: string; introduced_by: string }>(
      `SELECT object_name, introduced_by FROM public.schema_object_manifest
       WHERE (object_type = 'relation' AND object_name = 'r:ownership_transfer_reversals')
          OR (object_type = 'routine' AND object_name LIKE 'iub_lock_request(%')
       ORDER BY object_name`,
    );
    expect(p0Objects.rows).toEqual([
      { object_name: "iub_lock_request(p_request_id bigint)", introduced_by: "0004_p0_integrity" },
      { object_name: "r:ownership_transfer_reversals", introduced_by: "0004_p0_integrity" },
    ]);
  }, 30_000);
});
