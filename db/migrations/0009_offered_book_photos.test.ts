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
];

const digest = (byte: number) => Buffer.alloc(32, byte);
const tokenHash = digest(11);

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
  for (const name of migrationNames) {
    await database.exec(await migrationText(name));
  }
  await database.exec("COMMIT");
  await database.exec("RESET ROLE");
  return database;
}

describe("offered-book photographic review", () => {
  let database: PGlite;
  let sequence = 0;
  let copyId: number;
  let reviewerId: number;
  let requestReviewerId: number;

  beforeEach(async () => {
    database = await createDatabase();
    const reviewer = await database.query<{ id: string }>(
      `INSERT INTO public.app_users (identity_issuer, identity_subject)
       VALUES ('https://issuer.test', 'photo-reviewer') RETURNING id`,
    );
    reviewerId = Number(reviewer.rows[0]!.id);
    const role = await database.query<{ id: string }>(
      `INSERT INTO public.roles (role_key, display_name) VALUES ('photo_role', 'Photo role') RETURNING id`,
    );
    const roleId = Number(role.rows[0]!.id);
    await database.query(
      "INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)",
      [reviewerId, roleId],
    );
    await database.query(
      `INSERT INTO public.role_permissions (role_id, permission_id)
       SELECT $1, id FROM public.permissions WHERE permission_key = 'offered_books.review'`,
      [roleId],
    );

    const requestReviewer = await database.query<{ id: string }>(
      `INSERT INTO public.app_users (identity_issuer, identity_subject)
       VALUES ('https://issuer.test', 'request-reviewer') RETURNING id`,
    );
    requestReviewerId = Number(requestReviewer.rows[0]!.id);
    const requestRole = await database.query<{ id: string }>(
      `INSERT INTO public.roles (role_key, display_name) VALUES ('request_role', 'Request role') RETURNING id`,
    );
    const requestRoleId = Number(requestRole.rows[0]!.id);
    await database.query(
      "INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)",
      [requestReviewerId, requestRoleId],
    );
    await database.query(
      `INSERT INTO public.role_permissions (role_id, permission_id)
       SELECT $1, id FROM public.permissions WHERE permission_key = 'requests.review'`,
      [requestRoleId],
    );

    const publisher = await database.query<{ id: string }>(
      `INSERT INTO public.publishers (name, normalized_name) VALUES ('Photo Pub', 'photo-pub') RETURNING id`,
    );
    const genre = await database.query<{ id: string }>(
      `INSERT INTO public.genres (name, normalized_name) VALUES ('Photo Genre', 'photo-genre') RETURNING id`,
    );
    const bib = await database.query<{ id: string }>(
      `INSERT INTO public.bibliographic_records (title, author, publisher_id, genre_id)
       VALUES ('Foto titulo', 'Foto autor', $1, $2) RETURNING id`,
      [Number(publisher.rows[0]!.id), Number(genre.rows[0]!.id)],
    );
    const copy = await database.query<{ id: string }>(
      `INSERT INTO public.copies
       (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
       VALUES ($1, 'PHOTO-COPY-1', 'good', 'available', 'preexisting') RETURNING id`,
      [Number(bib.rows[0]!.id)],
    );
    copyId = Number(copy.rows[0]!.id);

    await database.query(
      `INSERT INTO public.privacy_notices (version, content_sha256, approved_at)
       VALUES ('photo-notice', $1, clock_timestamp())`,
      [digest(12)],
    );
  });

  afterEach(async () => {
    await database.close();
  });

  async function createDraft(token = tokenHash): Promise<number> {
    const result = await database.query<{ submission_id: string }>(
      `SELECT * FROM public.create_offered_book_submission(
        $1, $2, $3, $4, $5, $6, NULL, NULL, $7, $8, $9
      )`,
      [copyId, token, "Libro ofrecido", "Autora", "Editorial", "Genero", "good", "Observaciones", `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`],
    );
    return Number(result.rows[0]!.submission_id);
  }

  async function addEvidence(
    submissionId: number,
    slot: string,
    idempotencyKey: string,
    bytes = 1200,
  ): Promise<number> {
    const result = await database.query<{ evidence_id: string; storage_key: string }>(
      `SELECT * FROM public.register_offered_book_evidence(
        $1, $2, $3, $4, 'image/jpeg', $5, $6, 1200, 1600, $7
      )`,
      [submissionId, tokenHash, slot, `${submissionId}-${slot}-${idempotencyKey}.jpg`, bytes, digest(13), idempotencyKey],
    );
    return Number(result.rows[0]!.evidence_id);
  }

  function payload(title = "Libro ofrecido", author = "Autora", condition = "good") {
    return {
      participant: {
        fullNameCiphertext: "aa".repeat(32),
        fullNameKeyVersion: 1,
        emailCiphertext: "bb".repeat(32),
        emailKeyVersion: 1,
        identityCiphertext: "cc".repeat(32),
        identityKeyVersion: 1,
        identityFingerprint: "dd".repeat(32),
        hmacKeyVersion: 1,
      },
      consent: { noticeVersion: "photo-notice", evidenceSha256: "ee".repeat(32) },
      request: { requestedCopyId: copyId, accessTokenSha256: "ff".repeat(32) },
      offeredBook: {
        title,
        author,
        publisherClaim: "Editorial",
        genreClaim: "Genero",
        isbn: null,
        isbnNormalized: null,
        declaredCondition: condition,
        observations: "Observaciones",
      },
    };
  }

  async function submit(submissionId: number, key: string) {
    return database.query<{
      request_id: string;
      request_code: string;
      participant_id: string;
      privacy_consent_id: string;
    }>(
      `SELECT * FROM public.submit_offered_book_submission($1, $2, $3, $4::jsonb, $5)`,
      [submissionId, tokenHash, `PHOTO-REQUEST-${sequence}`, JSON.stringify(payload()), key],
    );
  }

  async function resubmit(submissionId: number, key: string) {
    return database.query<{ request_id: string; request_code: string }>(
      "SELECT * FROM public.resubmit_offered_book_submission($1, $2, $3)",
      [submissionId, tokenHash, key],
    );
  }

  async function review(submissionId: number, action: string, key: string, reason = "revisión") {
    return database.query<{ status: string }>(
      `SELECT * FROM public.review_offered_book_submission($1, $2, $3, $4, '', $5)`,
      [submissionId, reviewerId, action, reason, key],
    );
  }

  it("creates a draft, registers private evidence and submits with required slots", async () => {
    const submissionId = await createDraft();
    const cover = await addEvidence(submissionId, "cover", "20000000-0000-4000-8000-000000000001");
    await addEvidence(submissionId, "interior", "20000000-0000-4000-8000-000000000002");

    const state = await database.query<{ status: string }>(
      "SELECT status FROM public.offered_book_submissions WHERE id = $1",
      [submissionId],
    );
    expect(state.rows[0]?.status).toBe("draft");

    const submitted = await submit(submissionId, "20000000-0000-4000-8000-000000000003");
    expect(submitted.rows[0]?.request_code).toContain("PHOTO-REQUEST-");
    const finalState = await database.query<{ status: string; request_id: string }>(
      "SELECT status, request_id FROM public.offered_book_submissions WHERE id = $1",
      [submissionId],
    );
    expect(finalState.rows[0]?.status).toBe("pending_review");
    expect(Number(finalState.rows[0]?.request_id)).toBeGreaterThan(0);

    const evidence = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.offered_book_evidence WHERE submission_id = $1 AND deleted_at IS NULL",
      [submissionId],
    );
    expect(evidence.rows[0]?.count).toBe(2);
    expect(cover).toBeTruthy();

    const copyState = await database.query<{ availability: string }>(
      "SELECT availability FROM public.copies WHERE id = $1",
      [copyId],
    );
    expect(copyState.rows[0]?.availability).toBe("available");
  });

  it("rejects submission without cover or interior evidence", async () => {
    const submissionId = await createDraft();
    await addEvidence(submissionId, "cover", "20000000-0000-4000-8000-000000000011");
    await expect(submit(submissionId, "20000000-0000-4000-8000-000000000012")).rejects.toThrow(
      /cover and interior photographs are required/,
    );

    const counts = await database.query<{ participants: number; requests: number }>(
      `SELECT
        (SELECT count(*)::int FROM public.participants) AS participants,
        (SELECT count(*)::int FROM public.exchange_requests) AS requests`,
    );
    expect(counts.rows[0]).toEqual({ participants: 0, requests: 0 });
  });

  it("requires a permissioned reviewer and valid transitions", async () => {
    const submissionId = await createDraft();
    await addEvidence(submissionId, "cover", "20000000-0000-4000-8000-000000000021");
    await addEvidence(submissionId, "interior", "20000000-0000-4000-8000-000000000022");
    await submit(submissionId, "20000000-0000-4000-8000-000000000023");

    await expect(
      database.query(
        `SELECT * FROM public.review_offered_book_submission(
          $1, $2, 'preapprove', 'sin permiso', '', gen_random_uuid()
        )`,
        [submissionId, requestReviewerId],
      ),
    ).rejects.toThrow(/lacks permission/);

    await expect(review(submissionId, "preapprove", "20000000-0000-4000-8000-000000000024")).rejects.toThrow(
      /preapproval can only happen from in_review/,
    );

    await expect(review(submissionId, "start_review", "20000000-0000-4000-8000-000000000025")).resolves.toBeTruthy();
    const state = await database.query<{ status: string }>(
      "SELECT status FROM public.offered_book_submissions WHERE id = $1",
      [submissionId],
    );
    expect(state.rows[0]?.status).toBe("in_review");
  });

  it("blocks request approval until photographic preapproval and does not enable inventory", async () => {
    const submissionId = await createDraft();
    await addEvidence(submissionId, "cover", "20000000-0000-4000-8000-000000000031");
    await addEvidence(submissionId, "interior", "20000000-0000-4000-8000-000000000032");
    const submitted = await submit(submissionId, "20000000-0000-4000-8000-000000000033");
    const requestId = Number(submitted.rows[0]!.request_id);

    await database.query(
      "SELECT public.set_request_status($1, 'under_review', $2, 'review')",
      [requestId, requestReviewerId],
    );
    await expect(
      database.query(
        "SELECT public.set_request_status($1, 'approved', $2, 'approve')",
        [requestId, requestReviewerId],
      ),
    ).rejects.toThrow(/photographs must be preapproved/);

    await review(submissionId, "start_review", "20000000-0000-4000-8000-000000000034");
    await review(submissionId, "preapprove", "20000000-0000-4000-8000-000000000035", "fotos suficientes");
    const workflow = await database.query<{ workflow_status: string }>(
      "SELECT workflow_status FROM public.offered_book_submission_workflow WHERE submission_id = $1",
      [submissionId],
    );
    expect(workflow.rows[0]?.workflow_status).toBe("preapproved");

    await database.query(
      "SELECT public.set_request_status($1, 'approved', $2, 'approve')",
      [requestId, requestReviewerId],
    );
    const final = await database.query<{ request_status: string; availability: string; admissions: number }>(
      `SELECT r.status AS request_status, c.availability,
              (SELECT count(*)::int FROM public.inventory_admissions) AS admissions
       FROM public.exchange_requests r JOIN public.copies c ON c.id = r.requested_copy_id
       WHERE r.id = $1`,
      [requestId],
    );
    expect(final.rows[0]).toEqual({ request_status: "approved", availability: "available", admissions: 0 });
  });

  it("supports needs_information and resubmission without creating a second request", async () => {
    const submissionId = await createDraft();
    await addEvidence(submissionId, "cover", "20000000-0000-4000-8000-000000000041");
    await addEvidence(submissionId, "interior", "20000000-0000-4000-8000-000000000042");
    const submitted = await submit(submissionId, "20000000-0000-4000-8000-000000000043");
    const requestId = Number(submitted.rows[0]!.request_id);

    await review(submissionId, "start_review", "20000000-0000-4000-8000-000000000044");
    await review(submissionId, "request_information", "20000000-0000-4000-8000-000000000045", "falta lomo");
    const needs = await database.query<{ status: string }>(
      "SELECT status FROM public.offered_book_submissions WHERE id = $1",
      [submissionId],
    );
    expect(needs.rows[0]?.status).toBe("needs_information");

    const resubmitted = await resubmit(submissionId, "20000000-0000-4000-8000-000000000046");
    expect(Number(resubmitted.rows[0]!.request_id)).toBe(requestId);
    const counts = await database.query<{ requests: number }>(
      "SELECT count(*)::int AS requests FROM public.exchange_requests",
    );
    expect(counts.rows[0]?.requests).toBe(1);
  });

  it("keeps evidence private to the token and hides it from another token", async () => {
    const submissionId = await createDraft();
    const evidenceId = await addEvidence(submissionId, "cover", "20000000-0000-4000-8000-000000000051");

    const own = await database.query<{ evidence_id: string }>(
      "SELECT * FROM public.get_offered_book_evidence($1, $2)",
      [evidenceId, tokenHash],
    );
    expect(Number(own.rows[0]?.evidence_id)).toBe(evidenceId);

    const other = await database.query<{ evidence_id: string }>(
      "SELECT * FROM public.get_offered_book_evidence($1, $2)",
      [evidenceId, digest(99)],
    );
    expect(other.rows).toHaveLength(0);

    const wrongSubmission = await database.query(
      "SELECT * FROM public.get_offered_book_submission($1, $2)",
      [submissionId, digest(99)],
    );
    expect(wrongSubmission.rows[0]?.get_offered_book_submission).toBeNull();
  });

  it("soft-deletes evidence with the owner token and enforces the file limit", async () => {
    const submissionId = await createDraft();
    const evidenceId = await addEvidence(submissionId, "cover", "20000000-0000-4000-8000-000000000071");

    await expect(
      database.query("SELECT * FROM public.delete_offered_book_evidence($1, $2)", [evidenceId, digest(99)]),
    ).rejects.toThrow(/invalid submission token/);

    await database.query("SELECT * FROM public.delete_offered_book_evidence($1, $2)", [evidenceId, tokenHash]);
    const deleted = await database.query(
      "SELECT * FROM public.get_offered_book_evidence($1, $2)",
      [evidenceId, tokenHash],
    );
    expect(deleted.rows).toHaveLength(0);

    for (let index = 0; index < 12; index += 1) {
      await addEvidence(submissionId, "cover", `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    }
    await expect(
      addEvidence(submissionId, "cover", "30000000-0000-4000-8000-000000000099"),
    ).rejects.toThrow(/maximum number of evidence files/);
  });

  it("rejects invalid evidence metadata and enforces idempotency", async () => {
    const submissionId = await createDraft();
    await expect(
      database.query(
        `SELECT * FROM public.register_offered_book_evidence(
          $1, $2, 'invalid', 'bad.jpg', 'image/jpeg', 100, $3, 10, 10, gen_random_uuid()
        )`,
        [submissionId, tokenHash, digest(1)],
      ),
    ).rejects.toThrow(/invalid evidence slot/);

    await expect(
      database.query(
        `SELECT * FROM public.register_offered_book_evidence(
          $1, $2, 'cover', 'bad.jpg', 'image/svg+xml', 100, $3, 10, 10, gen_random_uuid()
        )`,
        [submissionId, tokenHash, digest(1)],
      ),
    ).rejects.toThrow(/unsupported image type/);

    const key = "20000000-0000-4000-8000-000000000061";
    const first = await addEvidence(submissionId, "cover", key);
    const second = await addEvidence(submissionId, "cover", key);
    expect(second).toBe(first);
  });
});
