// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const baselineMigrations = [
  "0001_initial_schema.sql",
  "0002_corrective_schema.sql",
  "0003_runtime_privileges.sql",
  "0004_p0_integrity.sql",
  "0005_participant_api.sql",
];

const repairMigration = "0020_inventory_integrity_repair.sql";

async function migrationText(name: string): Promise<string> {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

async function createBaseline(): Promise<PGlite> {
  const database = new PGlite();
  await database.waitReady;
  await database.exec(`
    CREATE ROLE iub_schema_migrator LOGIN;
    CREATE ROLE iub_public_runtime LOGIN;
    CREATE ROLE iub_admin_runtime LOGIN;
    GRANT USAGE, CREATE ON SCHEMA public TO iub_schema_migrator;
    SET ROLE iub_schema_migrator;
  `);
  for (const name of baselineMigrations) {
    await database.exec(await migrationText(name));
  }
  // Keep the migration role active so the repair migration, its objects and
  // the tests all exercise the same ownership model as production.
  return database;
}

async function createLegacyCopy(database: PGlite): Promise<number> {
  const publisher = await database.query<{ id: string }>(
    `INSERT INTO public.publishers (name, normalized_name)
     VALUES ('Legacy Publisher', 'legacy publisher') RETURNING id`,
  );
  const bib = await database.query<{ id: string }>(
    `INSERT INTO public.bibliographic_records (title, author, publisher_id)
     VALUES ('Legacy Visible Book', 'Legacy Author', $1) RETURNING id`,
    [Number(publisher.rows[0]!.id)],
  );
  const copy = await database.query<{ id: string }>(
    `INSERT INTO public.copies
       (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
     VALUES ($1, 'LEGACY-001', 'good', 'available', 'institutional') RETURNING id`,
    [Number(bib.rows[0]!.id)],
  );
  return Number(copy.rows[0]!.id);
}

async function createLegacyReservedCopy(database: PGlite): Promise<number> {
  const bib = await database.query<{ id: string }>(
    `INSERT INTO public.bibliographic_records (title, author)
     VALUES ('Legacy Reserved Book', 'Legacy Reserved Author') RETURNING id`,
  );
  const copy = await database.query<{ id: string }>(
    `INSERT INTO public.copies
       (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
     VALUES ($1, 'LEGACY-RESERVED-001', 'good', 'reserved', 'institutional') RETURNING id`,
    [Number(bib.rows[0]!.id)],
  );
  return Number(copy.rows[0]!.id);
}

async function createInstitutionalCopy(
  database: PGlite,
  label: string,
  availability = "unavailable",
  condition = "good",
): Promise<number> {
  const bib = await database.query<{ id: string }>(
    `INSERT INTO public.bibliographic_records (title, author)
     VALUES ($1, $2) RETURNING id`,
    [`Titulo ${label}`, `Autor ${label}`],
  );
  const copy = await database.query<{ id: string }>(
    `INSERT INTO public.copies
       (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
     VALUES ($1, $2, $3, $4, 'institutional') RETURNING id`,
    [Number(bib.rows[0]!.id), `COPY-${label}`, condition, availability],
  );
  return Number(copy.rows[0]!.id);
}

async function seedActor(database: PGlite): Promise<number> {
  const actor = await database.query<{ id: string }>(
    `INSERT INTO public.app_users (identity_issuer, identity_subject)
     VALUES ('https://issuer.test', 'repair-actor') RETURNING id`,
  );
  return Number(actor.rows[0]!.id);
}

async function grantRepairPermissions(database: PGlite, actorId: number): Promise<void> {
  const role = await database.query<{ id: string }>(
    `INSERT INTO public.roles (role_key, display_name)
     VALUES ('repair_admin', 'Repair Admin') RETURNING id`,
  );
  const roleId = Number(role.rows[0]!.id);
  await database.query(
    "INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)",
    [actorId, roleId],
  );
  await database.query(
    `INSERT INTO public.role_permissions (role_id, permission_id)
     SELECT $1, id FROM public.permissions
     WHERE permission_key IN (
       'inventory.verify', 'inventory.publish', 'inventory.withdraw',
       'inventory.events.import', 'inventory.classify_synthetic'
     )`,
    [roleId],
  );
}

describe("0020 inventory integrity repair", () => {
  let database: PGlite;
  let legacyCopyId: number;
  let legacyReservedCopyId: number;
  let actorId: number;

  beforeEach(async () => {
    database = await createBaseline();
    legacyCopyId = await createLegacyCopy(database);
    legacyReservedCopyId = await createLegacyReservedCopy(database);
    actorId = await seedActor(database);
    await database.exec(await migrationText(repairMigration));
    await grantRepairPermissions(database, actorId);
  });

  afterEach(async () => {
    await database.close();
  });

  it("preserves legacy catalogue visibility without verifying or changing the copy", async () => {
    const state = await database.query<{
      availability: string;
      verified_at: string | null;
      is_synthetic: boolean;
      in_catalog: boolean;
      exempted: boolean;
    }>(
      `SELECT c.availability, c.verified_at, c.is_synthetic,
              EXISTS (SELECT 1 FROM public.available_catalog ac WHERE ac.copy_id = c.id) AS in_catalog,
              EXISTS (SELECT 1 FROM public.catalog_verification_exemptions e WHERE e.copy_id = c.id) AS exempted
       FROM public.copies c WHERE c.id = $1`,
      [legacyCopyId],
    );

    expect(state.rows[0]).toEqual({
      availability: "available",
      verified_at: null,
      is_synthetic: false,
      in_catalog: true,
      exempted: true,
    });
  });

  it("preserves legacy reserved commitments without exposing them in the catalogue", async () => {
    const state = await database.query<{
      availability: string;
      in_catalog: boolean;
      exempted: boolean;
      backlog: boolean;
    }>(
      `SELECT c.availability,
              EXISTS (SELECT 1 FROM public.available_catalog ac WHERE ac.copy_id = c.id) AS in_catalog,
              EXISTS (SELECT 1 FROM public.catalog_verification_exemptions e WHERE e.copy_id = c.id) AS exempted,
              EXISTS (SELECT 1 FROM public.institutional_verification_backlog b WHERE b.copy_id = c.id) AS backlog
       FROM public.copies c WHERE c.id = $1`,
      [legacyReservedCopyId],
    );

    expect(state.rows[0]).toEqual({
      availability: "reserved",
      in_catalog: false,
      exempted: true,
      backlog: true,
    });
  });

  it("requires verification and an audited publication path for new institutional stock", async () => {
    const copyId = await createInstitutionalCopy(database, "new-stock");

    await expect(
      database.query("UPDATE public.copies SET availability = 'available' WHERE id = $1", [copyId]),
    ).rejects.toThrow(/unverified institutional copy/);

    await database.query(
      "SELECT public.verify_institutional_copy($1, $2, 'evidence-001')",
      [copyId, actorId],
    );

    const before = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.available_catalog WHERE copy_id = $1",
      [copyId],
    );
    expect(before.rows[0]?.count).toBe(0);

    await database.query(
      "SELECT public.publish_institutional_copy($1, $2, '11111111-1111-4111-8111-111111111111')",
      [copyId, actorId],
    );

    const after = await database.query<{
      availability: string;
      verified: boolean;
      in_catalog: boolean;
      movement_count: number;
      audit_count: number;
    }>(
      `SELECT c.availability,
              (c.verified_at IS NOT NULL) AS verified,
              EXISTS (SELECT 1 FROM public.available_catalog ac WHERE ac.copy_id = c.id) AS in_catalog,
              (SELECT count(*)::int FROM public.inventory_movements m
                WHERE m.copy_id = c.id AND m.movement_type = 'availability_changed') AS movement_count,
              (SELECT count(*)::int FROM public.audit_events a
                WHERE a.resource_type = 'copy' AND a.resource_id = c.id::text
                  AND a.event_type = 'inventory.institutional_copy_published') AS audit_count
       FROM public.copies c WHERE c.id = $1`,
      [copyId],
    );

    expect(after.rows[0]).toEqual({
      availability: "available",
      verified: true,
      in_catalog: true,
      movement_count: 1,
      audit_count: 1,
    });

    await database.query(
      "SELECT public.publish_institutional_copy($1, $2, '11111111-1111-4111-8111-111111111111')",
      [copyId, actorId],
    );
    const idempotent = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.inventory_movements WHERE copy_id = $1 AND idempotency_key = $2",
      [copyId, "11111111-1111-4111-8111-111111111111"],
    );
    expect(idempotent.rows[0]?.count).toBe(1);
  });

  it("blocks uncontrolled demotion and makes withdrawal idempotent and audited", async () => {
    await expect(
      database.query("UPDATE public.copies SET availability = 'unavailable' WHERE id = $1", [legacyCopyId]),
    ).rejects.toThrow(/authorized withdrawal/);

    await database.query(
      "SELECT public.withdraw_copy($1, 'retired', 'legacy test quarantine', $2, '22222222-2222-4222-8222-222222222222')",
      [legacyCopyId, actorId],
    );
    await database.query(
      "SELECT public.withdraw_copy($1, 'retired', 'legacy test quarantine', $2, '22222222-2222-4222-8222-222222222222')",
      [legacyCopyId, actorId],
    );

    const state = await database.query<{
      availability: string;
      in_catalog: boolean;
      movements: number;
      audits: number;
    }>(
      `SELECT c.availability,
              EXISTS (SELECT 1 FROM public.available_catalog ac WHERE ac.copy_id = c.id) AS in_catalog,
              (SELECT count(*)::int FROM public.inventory_movements m
                WHERE m.copy_id = c.id AND m.idempotency_key = '22222222-2222-4222-8222-222222222222') AS movements,
              (SELECT count(*)::int FROM public.audit_events a
                WHERE a.resource_type = 'copy' AND a.resource_id = c.id::text
                  AND a.event_type = 'inventory.copy_withdrawn') AS audits
       FROM public.copies c WHERE c.id = $1`,
      [legacyCopyId],
    );

    expect(state.rows[0]).toEqual({
      availability: "retired",
      in_catalog: false,
      movements: 1,
      audits: 1,
    });

    await expect(
      database.query("UPDATE public.copies SET availability = 'available' WHERE id = $1", [legacyCopyId]),
    ).rejects.toThrow(/authorized reinstatement/);
  });

  it("imports event inventory without changing existing copies and is idempotent", async () => {
    const payload = {
      bibs: [{
        key: "B1",
        title: "Imported Event Book",
        author: "Event Author",
        publisher: "Event Publisher",
        isbn: "",
        isbn_normalized: "",
      }],
      copies: [
        { code: "LEGACY-001", bib_key: "B1", location: "Shelf" },
        { code: "EVENT-001", bib_key: "B1", location: "Shelf" },
      ],
    };

    const first = await database.query<{
      import_id: string;
      status: string;
      bibs_inserted: number;
      copies_inserted: number;
      copies_reused: number;
    }>(
      "SELECT * FROM public.import_event_inventory('event-test', $1::jsonb, $2, '33333333-3333-4333-8333-333333333333')",
      [JSON.stringify(payload), actorId],
    );

    expect(first.rows[0]).toMatchObject({
      status: "completed",
      bibs_inserted: 1,
      copies_inserted: 1,
      copies_reused: 1,
    });

    const existing = await database.query<{ availability: string }>(
      "SELECT availability FROM public.copies WHERE id = $1",
      [legacyCopyId],
    );
    expect(existing.rows[0]?.availability).toBe("available");

    const imported = await database.query<{ availability: string; movements: number }>(
      `SELECT c.availability,
              (SELECT count(*)::int FROM public.inventory_movements m WHERE m.copy_id = c.id) AS movements
       FROM public.copies c WHERE c.inventory_code = 'EVENT-001'`,
    );
    expect(imported.rows[0]).toEqual({ availability: "unavailable", movements: 1 });

    const second = await database.query<{ copies_inserted: number; copies_reused: number }>(
      "SELECT * FROM public.import_event_inventory('event-test', $1::jsonb, $2, '33333333-3333-4333-8333-333333333333')",
      [JSON.stringify(payload), actorId],
    );
    expect(second.rows[0]).toMatchObject({ copies_inserted: 1, copies_reused: 1 });

    const counts = await database.query<{ imports: number; copies: number }>(
      `SELECT
         (SELECT count(*)::int FROM public.inventory_event_imports WHERE idempotency_key = '33333333-3333-4333-8333-333333333333') AS imports,
         (SELECT count(*)::int FROM public.copies WHERE inventory_code = 'EVENT-001') AS copies`,
    );
    expect(counts.rows[0]).toEqual({ imports: 1, copies: 1 });

    await expect(
      database.query(
        "SELECT public.import_event_inventory('event-test', $1::jsonb, $2, '33333333-3333-4333-8333-333333333333')",
        [JSON.stringify({ ...payload, bibs: [{ ...payload.bibs[0], title: "Different" }] }), actorId],
      ),
    ).rejects.toThrow(/idempotency key conflict/);
  });

  it("classifies synthetic records and excludes them from real anomalies", async () => {
    const testBib = await database.query<{ id: string }>(
      `INSERT INTO public.bibliographic_records (title, author)
       VALUES ('Catalogado resume 1793222266176', 'Autora Staging') RETURNING id`,
    );
    const testCopy = await database.query<{ id: string }>(
      `INSERT INTO public.copies
         (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
       VALUES ($1, 'IUB-REC-R-1793222267404', 'good', 'unavailable', 'preexisting') RETURNING id`,
      [Number(testBib.rows[0]!.id)],
    );
    const testCopyId = Number(testCopy.rows[0]!.id);

    await database.query("SELECT public.classify_synthetic_inventory($1)", [actorId]);
    await database.query(
      `INSERT INTO public.inventory_movements
         (copy_id, movement_type, previous_availability, new_availability, reason)
       VALUES ($1, 'exchange_in', 'unavailable', 'available', 'test mismatch')`,
      [testCopyId],
    );

    const anomalies = await database.query<{ anomaly_code: string; is_synthetic: boolean }>(
      "SELECT anomaly_code, is_synthetic FROM public.inventory_anomalies WHERE copy_id = $1 ORDER BY anomaly_code",
      [testCopyId],
    );
    expect(anomalies.rows).toEqual([
      { anomaly_code: "availability_history_mismatch", is_synthetic: true },
    ]);

    const real = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.real_inventory_anomalies WHERE copy_id = $1",
      [testCopyId],
    );
    expect(real.rows[0]?.count).toBe(0);
  });

  it("does not grandfather copies that appear after the first application", async () => {
    await database.exec("ALTER TABLE public.copies DISABLE TRIGGER copies_institutional_eligibility_guard");
    try {
      await createInstitutionalCopy(database, "late-unverified", "available");
    } finally {
      await database.exec("ALTER TABLE public.copies ENABLE TRIGGER copies_institutional_eligibility_guard");
    }

    await database.exec(await migrationText(repairMigration));

    const late = await database.query<{ exempted: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM public.catalog_verification_exemptions e
         JOIN public.copies c ON c.id = e.copy_id
         WHERE c.inventory_code = 'COPY-late-unverified'
       ) AS exempted`,
    );
    expect(late.rows[0]?.exempted).toBe(false);
  });

  it("applies after 0007/0008 without conflicting with their objects", async () => {
    const compatible = new PGlite();
    await compatible.waitReady;
    try {
      await compatible.exec(`
        CREATE ROLE iub_schema_migrator LOGIN;
        CREATE ROLE iub_public_runtime LOGIN;
        CREATE ROLE iub_admin_runtime LOGIN;
        GRANT USAGE, CREATE ON SCHEMA public TO iub_schema_migrator;
        SET ROLE iub_schema_migrator;
      `);
      for (const name of [
        ...baselineMigrations,
        "0006_inventory_import.sql",
        "0007_institutional_containment.sql",
        "0008_containment_request_compat.sql",
      ]) {
        await compatible.exec(await migrationText(name));
      }
      await compatible.exec(await migrationText(repairMigration));

      const state = await compatible.query<{
        view: string;
        exemption_table: string;
        guard: string;
      }>(
        `SELECT
           to_regclass('public.available_catalog')::text AS view,
           to_regclass('public.catalog_verification_exemptions')::text AS exemption_table,
           (SELECT count(*)::text FROM pg_trigger
             WHERE tgname = 'copies_institutional_eligibility_guard') AS guard`,
      );
      expect(state.rows[0]).toEqual({
        view: "available_catalog",
        exemption_table: "catalog_verification_exemptions",
        guard: "1",
      });
    } finally {
      await compatible.close();
    }
  });

  it("enforces function permissions and keeps the public runtime read-only", async () => {
    const otherActor = await database.query<{ id: string }>(
      `INSERT INTO public.app_users (identity_issuer, identity_subject)
       VALUES ('https://issuer.test', 'no-permission') RETURNING id`,
    );
    await expect(
      database.query(
        "SELECT public.withdraw_copy($1, 'retired', 'unauthorized', $2, '44444444-4444-4444-8444-444444444444')",
        [legacyCopyId, Number(otherActor.rows[0]!.id)],
      ),
    ).rejects.toThrow(/lacks permission/);

    const privileges = await database.query<{
      public_withdraw: boolean;
      admin_withdraw: boolean;
      public_catalog: boolean;
    }>(
      `SELECT
         has_function_privilege('iub_public_runtime', 'public.withdraw_copy(bigint,text,text,bigint,uuid)', 'EXECUTE') AS public_withdraw,
         has_function_privilege('iub_admin_runtime', 'public.withdraw_copy(bigint,text,text,bigint,uuid)', 'EXECUTE') AS admin_withdraw,
         has_table_privilege('iub_public_runtime', 'public.available_catalog', 'SELECT') AS public_catalog`,
    );
    expect(privileges.rows[0]).toEqual({
      public_withdraw: false,
      admin_withdraw: true,
      public_catalog: true,
    });
  });
});
