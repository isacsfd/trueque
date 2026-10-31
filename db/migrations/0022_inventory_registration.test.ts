// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const baseline = [
  "0001_initial_schema.sql",
  "0002_corrective_schema.sql",
  "0003_runtime_privileges.sql",
  "0004_p0_integrity.sql",
  "0005_participant_api.sql",
];
const repair = "0020_inventory_integrity_repair.sql";
const registration = "0022_inventory_registration.sql";

async function migrationText(name: string): Promise<string> {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

describe("0022 manual inventory registration", () => {
  let database: PGlite;
  let actorId: number;
  let roleId: number;

  beforeEach(async () => {
    database = new PGlite();
    await database.waitReady;
    await database.exec(`
      CREATE ROLE iub_schema_migrator LOGIN;
      CREATE ROLE iub_public_runtime LOGIN;
      CREATE ROLE iub_admin_runtime LOGIN;
      GRANT USAGE, CREATE ON SCHEMA public TO iub_schema_migrator;
      SET ROLE iub_schema_migrator;
    `);
    for (const name of baseline) {
      await database.exec(await migrationText(name));
    }
    await database.exec(await migrationText(repair));

    const user = await database.query<{ id: string }>(
      `INSERT INTO public.app_users (identity_issuer, identity_subject)
       VALUES ('https://test', 'manual-registration-actor') RETURNING id`,
    );
    actorId = Number(user.rows[0]!.id);
    const role = await database.query<{ id: string }>(
      `INSERT INTO public.roles (role_key, display_name)
       VALUES ('manual_registration_test', 'Manual registration test') RETURNING id`,
    );
    roleId = Number(role.rows[0]!.id);
    await database.query(
      `INSERT INTO public.role_permissions (role_id, permission_id)
       SELECT $1, id FROM public.permissions
       WHERE permission_key IN ('inventory.admit', 'inventory.enable')`,
      [roleId],
    );
    await database.query(
      "INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)",
      [actorId, roleId],
    );

    await database.exec(await migrationText(registration));
  });

  afterEach(async () => {
    await database.close();
  });

  async function register(input: {
    condition?: string;
    reference?: string | null;
    publish?: boolean;
    key?: string;
  } = {}) {
    const values = [
      "Cien años de soledad",
      "Gabriel García Márquez",
      "Sudamericana",
      "Novela",
      null,
      null,
      "INV-MAN-001",
      "Estante A",
      input.condition ?? "good",
      input.reference === undefined ? "Acta física 2026-10-31" : input.reference,
      input.publish ?? false,
      actorId,
      input.key ?? "11111111-1111-4111-8111-111111111111",
    ];
    return database.query<{
      copy_id: string;
      bibliographic_record_id: string;
      availability: string;
      verified: boolean;
      created: boolean;
    }>(
      `SELECT * FROM public.register_institutional_copy(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
       )`,
      values,
    );
  }

  it("propagates permissions to inventory roles and registers an unavailable copy", async () => {
    const permissions = await database.query<{ permission_key: string }>(
      `SELECT p.permission_key
       FROM public.role_permissions rp
       JOIN public.permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = $1
         AND p.permission_key IN ('inventory.register', 'inventory.verify', 'inventory.publish')
       ORDER BY p.permission_key`,
      [roleId],
    );
    expect(permissions.rows.map((row) => row.permission_key)).toEqual([
      "inventory.publish",
      "inventory.register",
      "inventory.verify",
    ]);

    const result = await register();
    expect(result.rows[0]).toMatchObject({
      availability: "unavailable",
      verified: false,
      created: true,
    });

    const state = await database.query<{
      availability: string;
      verified_at: string | null;
      in_catalog: boolean;
      movements: number;
      audits: number;
    }>(
      `SELECT c.availability, c.verified_at,
              EXISTS (SELECT 1 FROM public.available_catalog ac WHERE ac.copy_id = c.id) AS in_catalog,
              (SELECT count(*)::int FROM public.inventory_movements m WHERE m.copy_id = c.id) AS movements,
              (SELECT count(*)::int FROM public.audit_events a
                WHERE a.resource_type = 'copy' AND a.resource_id = c.id::text
                  AND a.event_type = 'inventory.manual_copy_registered') AS audits
       FROM public.copies c WHERE c.id = $1`,
      [Number(result.rows[0]!.copy_id)],
    );
    expect(state.rows[0]).toEqual({
      availability: "unavailable",
      verified_at: null,
      in_catalog: false,
      movements: 1,
      audits: 1,
    });
  });

  it("publishes only when condition, evidence and permissions are present", async () => {
    const result = await register({ publish: true });
    expect(result.rows[0]).toMatchObject({
      availability: "available",
      verified: true,
      created: true,
    });

    const state = await database.query<{
      availability: string;
      verified_at: string | null;
      in_catalog: boolean;
      movements: number;
      published_audits: number;
    }>(
      `SELECT c.availability, c.verified_at,
              EXISTS (SELECT 1 FROM public.available_catalog ac WHERE ac.copy_id = c.id) AS in_catalog,
              (SELECT count(*)::int FROM public.inventory_movements m WHERE m.copy_id = c.id) AS movements,
              (SELECT count(*)::int FROM public.audit_events a
                WHERE a.resource_type = 'copy' AND a.resource_id = c.id::text
                  AND a.event_type = 'inventory.institutional_copy_published') AS published_audits
       FROM public.copies c WHERE c.id = $1`,
      [Number(result.rows[0]!.copy_id)],
    );
    expect(state.rows[0]).toMatchObject({
      availability: "available",
      verified_at: expect.any(Date),
      in_catalog: true,
      movements: 2,
      published_audits: 1,
    });
  });

  it("is idempotent by key and rejects duplicate inventory codes", async () => {
    const first = await register();
    const second = await register();
    expect(second.rows[0]).toMatchObject({
      copy_id: first.rows[0]!.copy_id,
      created: false,
    });
    const count = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.copies WHERE inventory_code = 'INV-MAN-001'",
    );
    expect(count.rows[0]?.count).toBe(1);

    await expect(
      register({ key: "22222222-2222-4222-8222-222222222222" }),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("rejects publication without an assessed condition or evidence", async () => {
    await expect(
      register({ condition: "unassessed", publish: true }),
    ).rejects.toThrow(/publication requires/i);

    await expect(
      register({ reference: null, publish: true }),
    ).rejects.toThrow(/publication requires/i);

    const count = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.copies WHERE provenance_reference LIKE 'manual:%'",
    );
    expect(count.rows[0]?.count).toBe(0);
  });

  it("allows registering unavailable copies when verification permissions are absent", async () => {
    await database.query(
      `DELETE FROM public.role_permissions
       WHERE role_id = $1
         AND permission_id IN (
           SELECT id FROM public.permissions
           WHERE permission_key IN ('inventory.verify', 'inventory.publish')
         )`,
      [roleId],
    );
    const result = await register();
    expect(result.rows[0]).toMatchObject({
      availability: "unavailable",
      verified: false,
    });
  });
});
