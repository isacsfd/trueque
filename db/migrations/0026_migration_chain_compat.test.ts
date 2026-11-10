// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const fullChain = [
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
  "0011_admin_accounts_and_request_guard.sql",
  "0012_admin_credentials.sql",
  "0013_admin_password_login.sql",
  "0014_admin_runtime_grants.sql",
  "0015_release_expired_reservations.sql",
  "0016_reservation_lifecycle.sql",
  "0017_public_request_status.sql",
  "0018_plan_exchange_delivery.sql",
  "0019_secure_public_status.sql",
  "0020_inventory_integrity_repair.sql",
  "0021_admin_workbench_indexes.sql",
  "0022_inventory_registration.sql",
  "0023_inventory_batch_autopublish.sql",
  "0024_loans.sql",
  "0025_loan_reactivation.sql",
  "0026_migration_chain_compat.sql",
];

const hex = (byte: number) => Buffer.alloc(32, byte).toString("hex");

async function migrationText(name: string): Promise<string> {
  return (await readFile(new URL(`./${name}`, import.meta.url), "utf8"))
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
}

describe("0026 migration chain compatibility", () => {
  let database: PGlite;
  let actorId: number;
  let copyId: number;

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
    for (const name of fullChain.filter((name) => name !== "0026_migration_chain_compat.sql")) {
      await database.exec(await migrationText(name));
    }

    const user = await database.query<{ id: string }>(
      `INSERT INTO public.app_users (identity_issuer, identity_subject)
       VALUES ('https://test', 'chain-compat-reviewer') RETURNING id`,
    );
    actorId = Number(user.rows[0]!.id);
    const role = await database.query<{ id: string }>(
      `INSERT INTO public.roles (role_key, display_name)
       VALUES ('chain_compat_reviewer', 'Chain compat reviewer') RETURNING id`,
    );
    const roleId = Number(role.rows[0]!.id);
    await database.query("INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)", [actorId, roleId]);
    await database.query(
      `INSERT INTO public.role_permissions (role_id, permission_id)
       SELECT $1, id FROM public.permissions
       WHERE permission_key IN ('requests.review', 'reservations.configure')`,
      [roleId],
    );

    await database.query(
      `INSERT INTO public.privacy_notices (version, content_sha256, approved_at)
       VALUES ('notice-chain', decode(repeat('41',32),'hex'), clock_timestamp())`,
    );
    await database.query("SELECT public.set_reservation_policy(172800, $1)", [actorId]);
    await database.query(
      `INSERT INTO public.publishers (name, normalized_name)
       VALUES ('Chain Publisher','chain-publisher')`,
    );
    await database.query(
      `INSERT INTO public.genres (name, normalized_name)
       VALUES ('Chain Genre','chain-genre')`,
    );
    const bib = await database.query<{ id: string }>(
      `INSERT INTO public.bibliographic_records (title, author, publisher_id, genre_id)
       SELECT 'Chain Book','Chain Author',p.id,g.id
       FROM public.publishers p, public.genres g
       WHERE p.normalized_name='chain-publisher' AND g.normalized_name='chain-genre'
       RETURNING id`,
    );
    const copy = await database.query<{ id: string }>(
      `INSERT INTO public.copies
         (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
       VALUES ($1, 'CHAIN-001', 'good', 'available', 'preexisting') RETURNING id`,
      [Number(bib.rows[0]!.id)],
    );
    copyId = Number(copy.rows[0]!.id);
  });

  afterEach(async () => {
    await database.close();
  });

  async function createRequest(): Promise<number> {
    const payload = {
      participant: {
        fullNameCiphertext: hex(50),
        fullNameKeyVersion: 1,
        emailCiphertext: hex(51),
        emailKeyVersion: 1,
        identityCiphertext: hex(52),
        identityKeyVersion: 1,
        identityFingerprint: hex(53),
        hmacKeyVersion: 1,
      },
      consent: { noticeVersion: "notice-chain", evidenceSha256: hex(54) },
      request: { requestedCopyId: copyId, accessTokenSha256: hex(55) },
      offeredBook: {
        title: "Chain offered book",
        author: "Chain author",
        publisherClaim: "Chain Publisher",
        genreClaim: "Chain Genre",
        isbn: null,
        isbnNormalized: null,
        declaredCondition: "good",
        observations: null,
      },
    };
    const rows = await database.query<{ request_id: string }>(
      "SELECT * FROM public.create_exchange_request($1, $2::jsonb, $3)",
      [`CHAIN-${Date.now()}-${Math.random()}`, JSON.stringify(payload), crypto.randomUUID()],
    );
    return Number(rows.rows[0]!.request_id);
  }

  it("bridges the known 0011/0016 approval conflict in a full new chain", async () => {
    const requestId = await createRequest();

    await database.query(
      "SELECT public.set_request_status($1, 'under_review', $2, 'review')",
      [requestId, actorId],
    );
    await expect(
      database.query(
        "SELECT public.set_request_status($1, 'approved', $2, 'approved before the bridge')",
        [requestId, actorId],
      ),
    ).rejects.toThrow(/no active reservation/i);

    await database.exec(await migrationText("0026_migration_chain_compat.sql"));

    await database.query(
      "SELECT public.set_request_status($1, 'approved', $2, 'approved after the bridge')",
      [requestId, actorId],
    );

    const state = await database.query<{
      request_status: string;
      copy_availability: string;
      reservation_status: string;
      loan_status: string;
    }>(
      `SELECT r.status AS request_status, c.availability AS copy_availability,
              res.status AS reservation_status, l.status AS loan_status
       FROM public.exchange_requests r
       JOIN public.copies c ON c.id = r.requested_copy_id
       JOIN public.reservations res ON res.request_id = r.id
       LEFT JOIN public.loans l ON l.reservation_id = res.id
       WHERE r.id = $1`,
      [requestId],
    );
    expect(state.rows[0]).toEqual({
      request_status: "approved",
      copy_availability: "reserved",
      reservation_status: "converted",
      loan_status: "committed",
    });
  });

  it("keeps 0010-dependent, inventory, loan and reactivation objects in the canonical chain", async () => {
    await database.exec(await migrationText("0026_migration_chain_compat.sql"));
    const objects = await database.query<{
      batches: boolean;
      autopublish: boolean;
      registration: boolean;
      loans: boolean;
      events: boolean;
      reactivation: boolean;
      workbench_index: boolean;
    }>(
      `SELECT
         to_regclass('public.inventory_batches') IS NOT NULL AS batches,
         to_regprocedure('public.confirm_inventory_batch_with_publication(bigint,bigint,uuid)') IS NOT NULL AS autopublish,
         to_regprocedure('public.register_institutional_copy(text,text,text,text,text,text,text,text,text,text,boolean,bigint,uuid)') IS NOT NULL AS registration,
         to_regclass('public.loans') IS NOT NULL AS loans,
         to_regclass('public.loan_events') IS NOT NULL AS events,
         to_regprocedure('public.reactivate_cancelled_loan(bigint,text,uuid,bigint)') IS NOT NULL AS reactivation,
         to_regclass('public.exchange_requests_created_at_id_idx') IS NOT NULL AS workbench_index`,
    );
    expect(objects.rows[0]).toEqual({
      batches: true,
      autopublish: true,
      registration: true,
      loans: true,
      events: true,
      reactivation: true,
      workbench_index: true,
    });

    const policy = await database.query<{ duration_seconds: number }>(
      "SELECT duration_seconds FROM public.reservation_policy WHERE policy_id = 1",
    );
    expect(policy.rows[0]?.duration_seconds).toBe(172800);

    const directWrites = await database.query<{ role_name: string; relname: string; privilege: string }>(
      `SELECT 'iub_admin_runtime' AS role_name, c.relname, p.privilege
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL (VALUES
         ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
       ) AS p(privilege)
       WHERE n.nspname = 'public'
         AND c.relname = 'admin_credentials'
         AND has_table_privilege('iub_admin_runtime', c.oid, p.privilege)`,
    );
    expect(directWrites.rows).toEqual([]);
  });

  it("fails clearly and without partial changes when 0010 is absent", async () => {
    const partial = new PGlite();
    await partial.waitReady;
    try {
      await partial.exec(`
        CREATE ROLE iub_schema_migrator LOGIN;
        CREATE ROLE iub_public_runtime LOGIN;
        CREATE ROLE iub_admin_runtime LOGIN;
        GRANT USAGE, CREATE ON SCHEMA public TO iub_schema_migrator;
        SET ROLE iub_schema_migrator;
      `);
      const withoutBatchTables = fullChain.filter(
        (name) => !["0010_inventory_batches.sql", "0023_inventory_batch_autopublish.sql"].includes(name),
      );
      for (const name of withoutBatchTables) {
        await partial.exec(await migrationText(name));
      }

      await expect(
        partial.exec(await migrationText("0023_inventory_batch_autopublish.sql")),
      ).rejects.toThrow(/0023 requires 0010 inventory batches/i);

      expect(
        (await partial.query(
          "SELECT to_regclass('public.inventory_batches') AS relation",
        )).rows[0]?.relation,
      ).toBeNull();
      expect(
        (await partial.query(
          "SELECT to_regprocedure('public.confirm_inventory_batch_with_publication(bigint,bigint,uuid)') AS relation",
        )).rows[0]?.relation,
      ).toBeNull();
    } finally {
      await partial.close();
    }
  });
});
