// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migrationNames = [
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
];

const digest = (byte: number) => Buffer.alloc(32, byte);
const fileHash = digest(31);

async function migrationText(name: string): Promise<string> {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

async function createDatabase(): Promise<PGlite> {
  const database = new PGlite();
  await database.waitReady;
  await database.exec(`
    CREATE ROLE iub_schema_migrator LOGIN;
    CREATE ROLE iub_public_runtime LOGIN;
    CREATE ROLE iub_admin_runtime LOGIN;
    GRANT USAGE, CREATE ON SCHEMA public TO iub_schema_migrator;
    SET ROLE iub_schema_migrator;
  `);
  await database.exec("BEGIN");
  for (const name of migrationNames) await database.exec(await migrationText(name));
  await database.exec("COMMIT");
  await database.exec("RESET ROLE");
  return database;
}

describe("inventory batch import", () => {
  let database: PGlite;
  let actorId: number;
  let reviewerId: number;
  let sequence = 0;

  beforeEach(async () => {
    database = await createDatabase();
    const actor = await database.query<{ id: string }>(
      `INSERT INTO public.app_users (identity_issuer, identity_subject)
       VALUES ('https://issuer.test', 'batch-importer') RETURNING id`,
    );
    actorId = Number(actor.rows[0]!.id);
    const role = await database.query<{ id: string }>(
      `INSERT INTO public.roles (role_key, display_name) VALUES ('batch_role', 'Batch role') RETURNING id`,
    );
    const roleId = Number(role.rows[0]!.id);
    await database.query("INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)", [actorId, roleId]);
    for (const permission of ["inventory.batches.import", "inventory.batches.confirm", "inventory.batches.read"]) {
      await database.query(
        `INSERT INTO public.role_permissions (role_id, permission_id)
         SELECT $1, id FROM public.permissions WHERE permission_key = $2`,
        [roleId, permission],
      );
    }
    const reviewer = await database.query<{ id: string }>(
      `INSERT INTO public.app_users (identity_issuer, identity_subject)
       VALUES ('https://issuer.test', 'batch-reviewer') RETURNING id`,
    );
    reviewerId = Number(reviewer.rows[0]!.id);
  });

  afterEach(async () => {
    await database.close();
  });

  function row(sourceRow: number, title: string, code: string | null = null) {
    return {
      source_row: sourceRow,
      raw: { TITULO: title, AUTOR: "Autora" },
      mapped: {
        title,
        author: "Autora",
        publisher: "Editorial",
        genre: null,
        isbn: null,
        isbn_normalized: null,
        inventory_code: code,
        location: "PLAZA DE LA PAZ",
        observations: null,
        source_number: String(sourceRow),
        copy_number: "1",
      },
      status: "valid",
      errors: [],
      warnings: [],
      inventory_code: code,
    };
  }

  async function store(rows: ReturnType<typeof row>[]) {
    return database.query<{
      batch_id: string; status: string; total_rows: number; valid_rows: number;
      warning_rows: number; rejected_rows: number; duplicate_rows: number;
    }>(
      `SELECT * FROM public.store_inventory_batch(
        $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11
      )`,
      [
        "lote.xlsx", fileHash, 1234, "Hoja1", 1,
        JSON.stringify({ title: "TITULO", author: "AUTOR" }),
        JSON.stringify(rows), actorId,
        `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
        `batch-${sequence}.xlsx`, "Lote de prueba",
      ],
    );
  }

  async function confirm(batchId: number) {
    return database.query<{ batch_id: string; status: string; inserted_rows: number; reused_rows: number; skipped_rows: number }>(
      "SELECT * FROM public.confirm_inventory_batch($1, $2, $3)",
      [batchId, actorId, `10000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`],
    );
  }

  it("prevalidates and confirms institutional copies as unavailable, unassessed and unverified", async () => {
    const stored = await store([row(2, "Titulo nuevo", "IUB-LOTE-TEST-1")]);
    const batchId = Number(stored.rows[0]!.batch_id);
    expect(stored.rows[0]?.status).toBe("prevalidated");

    const confirmed = await confirm(batchId);
    expect(confirmed.rows[0]).toMatchObject({ status: "confirmed", inserted_rows: 1, reused_rows: 0 });

    const copy = await database.query<{
      inventory_code: string; availability: string; physical_condition: string;
      verified_at: string | null; provenance_type: string; provenance_reference: string;
    }>("SELECT inventory_code, availability, physical_condition, verified_at, provenance_type, provenance_reference FROM public.copies WHERE inventory_code = 'IUB-LOTE-TEST-1'");
    expect(copy.rows[0]).toMatchObject({
      inventory_code: "IUB-LOTE-TEST-1",
      availability: "unavailable",
      physical_condition: "unassessed",
      verified_at: null,
      provenance_type: "institutional",
    });
    expect(copy.rows[0]?.provenance_reference).toContain(`inventory-batch:${batchId}:row:2`);

    const movements = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM public.inventory_movements");
    expect(movements.rows[0]?.count).toBe(0);
    const second = await confirm(batchId);
    expect(second.rows[0]).toMatchObject({ status: "confirmed", inserted_rows: 1, reused_rows: 0 });
  });

  it("reuses exact bibliographic records without overwriting them and keeps separate copies", async () => {
    const first = await store([row(2, "Titulo compartido", "IUB-LOTE-TEST-2")]);
    await confirm(Number(first.rows[0]!.batch_id));
    const second = await store([row(2, "Titulo compartido", "IUB-LOTE-TEST-3")]);
    const confirmed = await confirm(Number(second.rows[0]!.batch_id));
    expect(confirmed.rows[0]?.reused_rows).toBe(1);
    const counts = await database.query<{ copies: number; biblio: number }>(
      `SELECT
        (SELECT count(*)::int FROM public.copies WHERE inventory_code IN ('IUB-LOTE-TEST-2','IUB-LOTE-TEST-3')) AS copies,
        (SELECT count(*)::int FROM public.bibliographic_records WHERE title = 'Titulo compartido') AS biblio`,
    );
    expect(counts.rows[0]).toEqual({ copies: 2, biblio: 1 });
    const source = await database.query<{ title: string }>(
      "SELECT title FROM public.bibliographic_records WHERE title = 'Titulo compartido'",
    );
    expect(source.rows).toHaveLength(1);
  });

  it("cancels a prevalidation without creating copies", async () => {
    const stored = await store([row(2, "Titulo cancelado", "IUB-LOTE-TEST-4")]);
    const batchId = Number(stored.rows[0]!.batch_id);
    await database.query("SELECT * FROM public.cancel_inventory_batch($1, $2, $3)", [
      batchId, actorId, "20000000-0000-4000-8000-000000000001",
    ]);
    const state = await database.query<{ status: string; copies: number }>(
      `SELECT b.status, (SELECT count(*)::int FROM public.copies WHERE inventory_code = 'IUB-LOTE-TEST-4') AS copies
       FROM public.inventory_batches b WHERE b.id = $1`,
      [batchId],
    );
    expect(state.rows[0]).toEqual({ status: "cancelled", copies: 0 });
    await expect(confirm(batchId)).rejects.toThrow(/cannot be confirmed/);
  });

  it("rejects a duplicated inventory code atomically and leaves the batch prevalidated", async () => {
    const first = await store([row(2, "Uno", "IUB-LOTE-DUP")]);
    await confirm(Number(first.rows[0]!.batch_id));
    const duplicate = await store([row(2, "Dos", "IUB-LOTE-DUP")]);
    const batchId = Number(duplicate.rows[0]!.batch_id);
    await expect(confirm(batchId)).rejects.toThrow(/already exists/);
    const state = await database.query<{ status: string; copies: number }>(
      `SELECT b.status, (SELECT count(*)::int FROM public.copies WHERE inventory_code = 'IUB-LOTE-DUP') AS copies
       FROM public.inventory_batches b WHERE b.id = $1`,
      [batchId],
    );
    expect(state.rows[0]?.status).toBe("prevalidated");
    expect(state.rows[0]?.copies).toBe(1);
  });

  it("rejects an actor without the import permission", async () => {
    await expect(
      database.query(
        `SELECT * FROM public.store_inventory_batch(
          'x.xlsx', $1, 10, 'Hoja1', 1, '{}'::jsonb, '[]'::jsonb, $2, gen_random_uuid(), 'batch-x.xlsx', NULL
        )`,
        [digest(9), reviewerId],
      ),
    ).rejects.toThrow(/lacks permission/);
  });
});
