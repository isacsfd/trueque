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
  "0014_admin_runtime_grants.sql",
  "0015_release_expired_reservations.sql",
  "0016_reservation_lifecycle.sql",
  "0017_public_request_status.sql",
  "0018_plan_exchange_delivery.sql",
  "0019_secure_public_status.sql",
];

let sequence = 0;
const uuid = () => {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
};
const hex = (byte: number) => Buffer.alloc(32, byte).toString("hex");

async function createDatabase(): Promise<PGlite> {
  const database = new PGlite();
  await database.waitReady;
  await database.exec(`
    CREATE ROLE iub_schema_migrator LOGIN NOINHERIT;
    CREATE ROLE iub_public_runtime LOGIN NOINHERIT;
    CREATE ROLE iub_admin_runtime LOGIN NOINHERIT;
    GRANT USAGE, CREATE ON SCHEMA public TO iub_schema_migrator;
    SET ROLE iub_schema_migrator;
  `);
  for (const name of migrationNames) {
    await database.exec(await readFile(new URL(`./${name}`, import.meta.url), "utf8"));
  }
  return database;
}

describe("single-field public status token", () => {
  let database: PGlite;
  let managerId: number;
  let reviewerId: number;
  let copyIds: number[];

  beforeEach(async () => {
    database = await createDatabase();
    const manager = await database.query<{ id: string }>(
      `INSERT INTO public.app_users (identity_issuer, identity_subject)
       VALUES ('https://issuer.test', 'qa-status-manager') RETURNING id`,
    );
    managerId = Number(manager.rows[0]!.id);
    const role = await database.query<{ id: string }>(
      `INSERT INTO public.roles (role_key, display_name)
       VALUES ('qa_status_manager', 'QA status manager') RETURNING id`,
    );
    const roleId = Number(role.rows[0]!.id);
    await database.query("INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)", [
      managerId,
      roleId,
    ]);
    await database.query(
      `INSERT INTO public.role_permissions (role_id, permission_id)
       SELECT $1, id FROM public.permissions WHERE permission_key = 'requests.review'`,
      [roleId],
    );
    const reviewer = await database.query<{ id: string }>(
      `INSERT INTO public.app_users (identity_issuer, identity_subject)
       VALUES ('https://issuer.test', 'qa-status-reviewer') RETURNING id`,
    );
    reviewerId = Number(reviewer.rows[0]!.id);

    await database.query(
      `INSERT INTO public.privacy_notices (version, content_sha256, approved_at)
       VALUES ('notice-qa-status', decode(repeat('cc',32),'hex'), clock_timestamp())`,
    );
    await database.query(
      `INSERT INTO public.reservation_policy (policy_id, duration_seconds, updated_by)
       VALUES (1, 3600, $1)`,
      [managerId],
    );
    await database.query(
      `INSERT INTO public.publishers (name, normalized_name)
       VALUES ('QA Status Publisher','qa-status-publisher')`,
    );
    await database.query(
      `INSERT INTO public.genres (name, normalized_name)
       VALUES ('QA Status Genre','qa-status-genre')`,
    );
    await database.query(
      `INSERT INTO public.bibliographic_records (title, author, publisher_id, genre_id)
       SELECT 'QA Status Book','QA Author',p.id,g.id
       FROM public.publishers p, public.genres g
       WHERE p.normalized_name='qa-status-publisher' AND g.normalized_name='qa-status-genre'`,
    );
    const copies = await database.query<{ id: string }>(
      `INSERT INTO public.copies
         (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
       SELECT id, 'QA-STATUS-' || value, 'good', 'available', 'preexisting'
       FROM public.bibliographic_records,
            (VALUES ('1'),('2')) AS values(value)
       WHERE title='QA Status Book'
       RETURNING id`,
    );
    copyIds = copies.rows.map((row) => Number(row.id));
  });

  afterEach(async () => {
    await database.close();
  });

  async function createRequest(copyId: number, byte: number) {
    const accessHash = hex(byte + 5);
    const rows = await database.query<{ request_id: string; request_code: string }>(
      `SELECT * FROM public.create_exchange_request($1, $2::jsonb, $3)`,
      [
        `QA-STATUS-${byte}`,
        JSON.stringify({
          participant: {
            fullNameCiphertext: hex(byte),
            fullNameKeyVersion: 1,
            emailCiphertext: hex(byte + 1),
            emailKeyVersion: 1,
            identityCiphertext: hex(byte + 2),
            identityKeyVersion: 1,
            identityFingerprint: hex(byte + 3),
            hmacKeyVersion: 1,
          },
          consent: { noticeVersion: "notice-qa-status", evidenceSha256: hex(byte + 4) },
          request: { requestedCopyId: copyId, accessTokenSha256: accessHash },
          offeredBook: {
            title: `QA Offered Status ${byte}`,
            author: "QA Author",
            publisherClaim: "QA Status Publisher",
            genreClaim: "QA Status Genre",
            isbn: null,
            isbnNormalized: null,
            declaredCondition: "good",
            observations: "QA only",
          },
        }),
        uuid(),
      ],
    );
    return {
      id: Number(rows.rows[0]!.request_id),
      code: rows.rows[0]!.request_code,
      accessHash,
    };
  }

  it("returns a safe status with the request access token and isolates other requests", async () => {
    const first = await createRequest(copyIds[0]!, 20);
    const second = await createRequest(copyIds[1]!, 40);

    const own = await database.query<{
      request_code: string;
      status: string;
      reservation_status: string;
      requested_title: string;
    }>("SELECT * FROM public.get_public_request_status_by_token($1)", [Buffer.from(first.accessHash, "hex")]);
    expect(own.rows[0]).toMatchObject({
      request_code: first.code,
      status: "pending",
      reservation_status: "active",
      requested_title: "QA Status Book",
    });

    const other = await database.query(
      "SELECT * FROM public.get_public_request_status_by_token($1)",
      [Buffer.from(second.accessHash, "hex")],
    );
    expect(other.rows[0]?.request_code).toBe(second.code);
    expect(other.rows[0]?.request_code).not.toBe(first.code);

    const wrong = await database.query(
      "SELECT * FROM public.get_public_request_status_by_token($1)",
      [Buffer.from(hex(250), "hex")],
    );
    expect(wrong.rows).toHaveLength(0);

    expect(Object.keys(own.rows[0]!)).not.toEqual(
      expect.arrayContaining(["full_name", "email", "participant_id", "identity_ciphertext", "reservation_id"]),
    );

    const grants = await database.query<{
      public_status: boolean;
      rate_limit: boolean;
      issue_token: boolean;
    }>(
      `SELECT
         has_function_privilege('iub_public_runtime',
           'public.get_public_request_status_by_token(bytea)', 'EXECUTE') AS public_status,
         has_function_privilege('iub_public_runtime',
           'public.consume_public_status_rate_limit(bytea, integer, integer)', 'EXECUTE') AS rate_limit,
         has_function_privilege('iub_admin_runtime',
           'public.issue_request_lookup_token(bigint, bytea, bigint, text)', 'EXECUTE') AS issue_token`,
    );
    expect(grants.rows[0]).toEqual({ public_status: true, rate_limit: true, issue_token: true });
  });

  it("issues, uses and revokes a recovery token without touching the access token", async () => {
    const request = await createRequest(copyIds[0]!, 60);
    const recoveryHash = hex(210);

    const issued = await database.query<{ token_id: string }>(
      "SELECT public.issue_request_lookup_token($1, $2, $3, $4) AS token_id",
      [request.id, Buffer.from(recoveryHash, "hex"), managerId, "recuperación de acceso"],
    );
    const tokenId = Number(issued.rows[0]!.token_id);
    expect(tokenId).toBeGreaterThan(0);

    const recovery = await database.query<{ request_code: string }>(
      "SELECT * FROM public.get_public_request_status_by_token($1)",
      [Buffer.from(recoveryHash, "hex")],
    );
    expect(recovery.rows[0]?.request_code).toBe(request.code);

    await database.query("SELECT public.revoke_request_lookup_token($1, $2)", [
      tokenId,
      managerId,
    ]);
    const revoked = await database.query(
      "SELECT * FROM public.get_public_request_status_by_token($1)",
      [Buffer.from(recoveryHash, "hex")],
    );
    expect(revoked.rows).toHaveLength(0);

    const originalStillWorks = await database.query<{ request_code: string }>(
      "SELECT * FROM public.get_public_request_status_by_token($1)",
      [Buffer.from(request.accessHash, "hex")],
    );
    expect(originalStillWorks.rows[0]?.request_code).toBe(request.code);
  });

  it("keeps recovery token issuance behind the review permission", async () => {
    const request = await createRequest(copyIds[0]!, 80);
    await expect(
      database.query("SELECT public.issue_request_lookup_token($1, $2, $3, $4)", [
        request.id,
        Buffer.from(hex(211), "hex"),
        reviewerId,
        "no permission",
      ]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("enforces persistent rate limits per bucket and resets a separate bucket", async () => {
    const bucket = Buffer.from(hex(220), "hex");
    const other = Buffer.from(hex(221), "hex");
    const first = await database.query<{ allowed: boolean }>(
      "SELECT * FROM public.consume_public_status_rate_limit($1, 2, 3600)",
      [bucket],
    );
    const second = await database.query<{ allowed: boolean; retry_after_seconds: number }>(
      "SELECT * FROM public.consume_public_status_rate_limit($1, 2, 3600)",
      [bucket],
    );
    const blocked = await database.query<{ allowed: boolean; retry_after_seconds: number }>(
      "SELECT * FROM public.consume_public_status_rate_limit($1, 2, 3600)",
      [bucket],
    );
    const independent = await database.query<{ allowed: boolean }>(
      "SELECT * FROM public.consume_public_status_rate_limit($1, 2, 3600)",
      [other],
    );

    expect(first.rows[0]!.allowed).toBe(true);
    expect(second.rows[0]!.allowed).toBe(true);
    expect(blocked.rows[0]!.allowed).toBe(false);
    expect(blocked.rows[0]!.retry_after_seconds).toBeGreaterThan(0);
    expect(independent.rows[0]!.allowed).toBe(true);
  });
});
