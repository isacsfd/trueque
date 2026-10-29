// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

const migrationUrl = new URL("./0001_initial_schema.sql", import.meta.url);
const correctiveUrl = new URL("./0002_corrective_schema.sql", import.meta.url);
const privilegesUrl = new URL("./0003_runtime_privileges.sql", import.meta.url);
const p0Url = new URL("./0004_p0_integrity.sql", import.meta.url);
const intakeUrl = new URL("./0005_participant_api.sql", import.meta.url);

describe("0005 participant intake", () => {
  let database: PGlite | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("creates a request idempotently and exposes status only with the token", async () => {
    database = new PGlite();
    await database.exec(`
      CREATE ROLE iub_schema_migrator LOGIN NOINHERIT;
      CREATE ROLE iub_public_runtime LOGIN NOINHERIT;
      CREATE ROLE iub_admin_runtime LOGIN NOINHERIT;
      GRANT USAGE, CREATE ON SCHEMA public TO iub_schema_migrator;
      SET ROLE iub_schema_migrator;
    `);
    for (const url of [migrationUrl, correctiveUrl, privilegesUrl, p0Url, intakeUrl]) {
      await database.exec(await readFile(url, "utf8"));
    }

    await database.exec(`
      INSERT INTO public.privacy_notices (version, content_sha256, approved_at)
      VALUES ('notice-test', decode(repeat('11',32),'hex'), clock_timestamp());
      INSERT INTO public.publishers (name, normalized_name) VALUES ('Test Pub','test-pub');
      INSERT INTO public.genres (name, normalized_name) VALUES ('Test Genre','test-genre');
      INSERT INTO public.bibliographic_records (title, author, publisher_id, genre_id)
      SELECT 'Test title','Test author',p.id,g.id
      FROM public.publishers p, public.genres g
      WHERE p.normalized_name='test-pub' AND g.normalized_name='test-genre';
      INSERT INTO public.copies
        (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
      SELECT id,'TEST-COPY-1','good','available','preexisting'
      FROM public.bibliographic_records WHERE title='Test title';
    `);

    const payload = `jsonb_build_object(
      'participant', jsonb_build_object(
        'fullNameCiphertext', repeat('aa',32), 'fullNameKeyVersion', 1,
        'emailCiphertext', repeat('bb',32), 'emailKeyVersion', 1,
        'identityCiphertext', repeat('cc',32), 'identityKeyVersion', 1,
        'identityFingerprint', repeat('dd',32), 'hmacKeyVersion', 1
      ),
      'consent', jsonb_build_object('noticeVersion','notice-test','evidenceSha256',repeat('ee',32)),
      'request', jsonb_build_object(
        'requestedCopyId',(SELECT id FROM public.copies WHERE inventory_code='TEST-COPY-1'),
        'accessTokenSha256',repeat('ff',32)
      ),
      'offeredBook', jsonb_build_object(
        'title','Offered','author','Author','declaredCondition','good',
        'isbn',NULL,'isbnNormalized',NULL
      )
    )`;

    const first = await database.query<{ request_id: string; request_code: string }>(
      `SELECT * FROM public.create_exchange_request(
        'TEST-REQUEST-1', ${payload}, '11111111-1111-4111-8111-111111111111'
      )`,
    );
    expect(first.rows[0]?.request_code).toBe("TEST-REQUEST-1");

    const replay = await database.query<{ request_id: string }>(
      `SELECT * FROM public.create_exchange_request(
        'TEST-REQUEST-1', ${payload}, '11111111-1111-4111-8111-111111111111'
      )`,
    );
    expect(replay.rows[0]?.request_id).toBe(first.rows[0]?.request_id);

    const counts = await database.query<{
      participants: number;
      consents: number;
      requests: number;
      offered: number;
    }>(`SELECT
      (SELECT count(*)::int FROM public.participants) AS participants,
      (SELECT count(*)::int FROM public.privacy_consents) AS consents,
      (SELECT count(*)::int FROM public.exchange_requests) AS requests,
      (SELECT count(*)::int FROM public.offered_books) AS offered`);
    expect(counts.rows[0]).toEqual({ participants: 1, consents: 1, requests: 1, offered: 1 });

    const status = await database.query<{ status: string; return_required: boolean }>(
      `SELECT status, return_required
       FROM public.get_request_status('TEST-REQUEST-1', decode(repeat('ff',32),'hex'))`,
    );
    expect(status.rows[0]).toEqual({ status: "pending", return_required: false });
    const wrongToken = await database.query(
      `SELECT * FROM public.get_request_status('TEST-REQUEST-1', decode(repeat('00',32),'hex'))`,
    );
    expect(wrongToken.rows).toHaveLength(0);
  }, 30_000);
});
