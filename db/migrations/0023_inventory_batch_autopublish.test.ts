// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migrations = [
  "0001_initial_schema.sql",
  "0002_corrective_schema.sql",
  "0003_runtime_privileges.sql",
  "0004_p0_integrity.sql",
  "0005_participant_api.sql",
  "0006_inventory_import.sql",
  "0007_institutional_containment.sql",
  "0008_containment_request_compat.sql",
  "0009_offered_book_photos.sql",
  "0010_inventory_batches.sql",
  "0020_inventory_integrity_repair.sql",
  "0023_inventory_batch_autopublish.sql",
];

async function migrationText(name: string): Promise<string> {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

describe("0023 inventory batch auto-publication", () => {
  let database: PGlite;
  let actorId: number;
  let batchId: number;

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
    for (const name of migrations) {
      await database.exec(await migrationText(name));
    }

    const user = await database.query<{ id: string }>(
      `INSERT INTO public.app_users (identity_issuer, identity_subject)
       VALUES ('https://test', 'batch-auto-publish-actor') RETURNING id`,
    );
    actorId = Number(user.rows[0]!.id);
    const role = await database.query<{ id: string }>(
      `INSERT INTO public.roles (role_key, display_name)
       VALUES ('batch_auto_publish_test', 'Batch auto publish test') RETURNING id`,
    );
    const roleId = Number(role.rows[0]!.id);
    await database.query(
      `INSERT INTO public.role_permissions (role_id, permission_id)
       SELECT $1, id FROM public.permissions
       WHERE permission_key IN (
         'inventory.batches.import', 'inventory.batches.confirm',
         'inventory.verify', 'inventory.publish'
       )`,
      [roleId],
    );
    await database.query(
      "INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)",
      [actorId, roleId],
    );

    const rows = [
      {
        source_row: 2,
        raw: { TITULO: "Publicable", AUTOR: "Autora", ESTADO: "good", VERIFICACION: "Acta 1" },
        mapped: {
          title: "Publicable", author: "Autora", physical_condition: "good",
          verification_reference: "Acta 1", inventory_code: "BATCH-AUTO-1",
        },
        status: "valid",
        errors: [],
        warnings: [],
        inventory_code: "BATCH-AUTO-1",
      },
      {
        source_row: 3,
        raw: { TITULO: "Pendiente", AUTOR: "Autor", ESTADO: "", VERIFICACION: "" },
        mapped: {
          title: "Pendiente", author: "Autor", physical_condition: null,
          verification_reference: null, inventory_code: "BATCH-AUTO-2",
        },
        status: "valid",
        errors: [],
        warnings: [],
        inventory_code: "BATCH-AUTO-2",
      },
    ];
    const stored = await database.query<{ batch_id: string }>(
      `SELECT * FROM public.store_inventory_batch(
         $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11
       )`,
      [
        "lote-auto.xlsx",
        Buffer.alloc(32, 1),
        100,
        "Hoja1",
        1,
        JSON.stringify({ title: "TITULO", author: "AUTOR", physical_condition: "ESTADO", verification_reference: "VERIFICACION", inventory_code: "CODIGO" }),
        JSON.stringify(rows),
        actorId,
        "11111111-1111-4111-8111-111111111111",
        "batch-auto.xlsx",
        null,
      ],
    );
    batchId = Number(stored.rows[0]!.batch_id);
  });

  afterEach(async () => {
    await database.close();
  });

  it("publishes eligible rows and leaves the rest unavailable", async () => {
    const result = await database.query<{
      inserted_rows: number;
      auto_published: number;
      auto_skipped: number;
    }>(
      "SELECT * FROM public.confirm_inventory_batch_with_publication($1, $2, $3)",
      [batchId, actorId, "22222222-2222-4222-8222-222222222222"],
    );
    expect(result.rows[0]).toMatchObject({
      inserted_rows: 2,
      auto_published: 1,
      auto_skipped: 1,
    });

    const state = await database.query<{
      inventory_code: string;
      availability: string;
      verified: boolean;
      in_catalog: boolean;
    }>(
      `SELECT c.inventory_code, c.availability,
              (c.verified_at IS NOT NULL) AS verified,
              EXISTS (SELECT 1 FROM public.available_catalog ac WHERE ac.copy_id = c.id) AS in_catalog
       FROM public.copies c
       WHERE c.inventory_code IN ('BATCH-AUTO-1', 'BATCH-AUTO-2')
       ORDER BY c.inventory_code`,
    );
    expect(state.rows).toEqual([
      { inventory_code: "BATCH-AUTO-1", availability: "available", verified: true, in_catalog: true },
      { inventory_code: "BATCH-AUTO-2", availability: "unavailable", verified: false, in_catalog: false },
    ]);

    const replay = await database.query<{
      auto_published: number;
      auto_skipped: number;
    }>(
      "SELECT * FROM public.confirm_inventory_batch_with_publication($1, $2, $3)",
      [batchId, actorId, "22222222-2222-4222-8222-222222222222"],
    );
    expect(replay.rows[0]).toMatchObject({ auto_published: 0, auto_skipped: 1 });
  });

  it("does not publish when the actor lacks verification permissions", async () => {
    await database.query(
      `DELETE FROM public.role_permissions
       WHERE role_id = (SELECT role_id FROM public.user_roles WHERE user_id = $1)
         AND permission_id IN (
           SELECT id FROM public.permissions
           WHERE permission_key IN ('inventory.verify', 'inventory.publish')
         )`,
      [actorId],
    );

    const result = await database.query<{
      auto_published: number;
      auto_skipped: number;
    }>(
      "SELECT * FROM public.confirm_inventory_batch_with_publication($1, $2, $3)",
      [batchId, actorId, "33333333-3333-4333-8333-333333333333"],
    );
    expect(result.rows[0]).toMatchObject({ auto_published: 0, auto_skipped: 2 });

    const available = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.copies
       WHERE inventory_code IN ('BATCH-AUTO-1', 'BATCH-AUTO-2') AND availability = 'available'`,
    );
    expect(available.rows[0]?.count).toBe(0);
  });
});
