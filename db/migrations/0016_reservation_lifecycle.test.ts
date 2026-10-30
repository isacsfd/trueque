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

describe("reservation lifecycle", () => {
  let database: PGlite;
  let reviewerId: number;
  let copyIds: number[];

  beforeEach(async () => {
    database = await createDatabase();

    const reviewer = await database.query<{ id: string }>(
      `INSERT INTO public.app_users (identity_issuer, identity_subject)
       VALUES ('https://issuer.test', 'qa-reviewer') RETURNING id`,
    );
    reviewerId = Number(reviewer.rows[0]!.id);
    const role = await database.query<{ id: string }>(
      `INSERT INTO public.roles (role_key, display_name)
       VALUES ('qa_reservation_reviewer', 'QA reservation reviewer') RETURNING id`,
    );
    const roleId = Number(role.rows[0]!.id);
    await database.query(
      "INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)",
      [reviewerId, roleId],
    );
    for (const permission of ["requests.review", "reservations.expire"]) {
      await database.query(
        `INSERT INTO public.role_permissions (role_id, permission_id)
         SELECT $1, id FROM public.permissions WHERE permission_key = $2`,
        [roleId, permission],
      );
    }

    await database.query(
      `INSERT INTO public.privacy_notices (version, content_sha256, approved_at)
       VALUES ('notice-qa', decode(repeat('11',32),'hex'), clock_timestamp())`,
    );
    await database.query(
      `INSERT INTO public.reservation_policy (policy_id, duration_seconds, updated_by)
       VALUES (1, 3600, $1)`,
      [reviewerId],
    );
    await database.query(
      `INSERT INTO public.publishers (name, normalized_name)
       VALUES ('QA Publisher','qa-publisher')`,
    );
    await database.query(
      `INSERT INTO public.genres (name, normalized_name)
       VALUES ('QA Genre','qa-genre')`,
    );
    await database.query(
      `INSERT INTO public.bibliographic_records (title, author, publisher_id, genre_id)
       SELECT 'QA Reservation Book','QA Author',p.id,g.id
       FROM public.publishers p, public.genres g
       WHERE p.normalized_name='qa-publisher' AND g.normalized_name='qa-genre'`,
    );
    const copies = await database.query<{ id: string }>(
      `INSERT INTO public.copies
         (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
       SELECT id, 'QA-RES-' || value, 'good', 'available', 'preexisting'
       FROM public.bibliographic_records,
            (VALUES ('1'),('2'),('3'),('4')) AS values(value)
       WHERE title='QA Reservation Book'
       RETURNING id`,
    );
    copyIds = copies.rows.map((row) => Number(row.id));
    expect(copyIds).toHaveLength(4);
  });

  afterEach(async () => {
    await database.close();
  });

  async function createRequest(copyId: number, byte: number, idempotencyKey = uuid()) {
    const code = `QA-RES-${byte}-${Date.now()}`;
    const payload = {
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
      consent: {
        noticeVersion: "notice-qa",
        evidenceSha256: hex(byte + 4),
      },
      request: {
        requestedCopyId: copyId,
        accessTokenSha256: hex(byte + 5),
      },
      offeredBook: {
        title: `QA Offered ${byte}`,
        author: "QA Author",
        publisherClaim: "QA Publisher",
        genreClaim: "QA Genre",
        isbn: null,
        isbnNormalized: null,
        declaredCondition: "good",
        observations: "QA only",
      },
    };
    const rows = await database.query<{ request_id: string; request_code: string }>(
      `SELECT * FROM public.create_exchange_request($1, $2::jsonb, $3)`,
      [code, JSON.stringify(payload), idempotencyKey],
    );
    return { id: Number(rows.rows[0]!.request_id), code: rows.rows[0]!.request_code };
  }

  async function moveToReview(requestId: number) {
    await database.query(
      `SELECT public.set_request_status($1, 'under_review', $2, $3)`,
      [requestId, reviewerId, ""],
    );
  }

  it("reserves atomically on request creation and rejects a second request for the same copy", async () => {
    const first = await createRequest(copyIds[0]!, 20);

    const reservation = await database.query<{
      id: string;
      status: string;
      copies: number;
      catalog: number;
    }>(
      `SELECT r.id, r.status,
              (SELECT count(*)::int FROM public.copies WHERE id = $1 AND availability = 'reserved') AS copies,
              (SELECT count(*)::int FROM public.available_catalog WHERE copy_id = $1) AS catalog
       FROM public.reservations r
       WHERE r.request_id = $2`,
      [copyIds[0], first.id],
    );
    expect(reservation.rows[0]).toEqual({ id: expect.any(Number), status: "active", copies: 1, catalog: 0 });

    // A different request for the same copy must fail; the copy is already held.
    await expect(createRequest(copyIds[0]!, 40)).rejects.toMatchObject({ code: "P0005" });
  });

  it("replays the same request idempotently without creating a second hold", async () => {
    const key = uuid();
    const first = await createRequest(copyIds[0]!, 30, key);
    const replay = await createRequest(copyIds[0]!, 30, key);
    expect(replay.id).toBe(first.id);

    const counts = await database.query<{ requests: number; reservations: number }>(
      `SELECT
         (SELECT count(*)::int FROM public.exchange_requests WHERE requested_copy_id = $1) AS requests,
         (SELECT count(*)::int FROM public.reservations WHERE copy_id = $1) AS reservations`,
      [copyIds[0]],
    );
    expect(counts.rows[0]).toEqual({ requests: 1, reservations: 1 });
  });

  it("has a database-level unique guard against two active holds for one copy", async () => {
    await createRequest(copyIds[0]!, 35);
    const other = await createRequest(copyIds[1]!, 36);

    await expect(database.query(
      `INSERT INTO public.reservations (copy_id, request_id, status, expires_at)
       VALUES ($1, $2, 'active', clock_timestamp() + interval '1 hour')`,
      [copyIds[0], other.id],
    )).rejects.toMatchObject({ code: "23505" });
  });

  it("expires only the affected hold and leaves another request untouched", async () => {
    const first = await createRequest(copyIds[0]!, 37);
    const second = await createRequest(copyIds[1]!, 38);
    await database.query(
      `UPDATE public.reservations
       SET created_at = clock_timestamp() - interval '2 minutes',
           expires_at = clock_timestamp() - interval '1 minute'
       WHERE request_id = $1`,
      [first.id],
    );
    await database.query(`SELECT public.expire_reservations($1, 100)`, [reviewerId]);

    const state = await database.query<{
      first_request: string;
      second_request: string;
      second_reservation: string;
      second_copy: string;
      second_catalog: number;
    }>(
      `SELECT
         (SELECT status FROM public.exchange_requests WHERE id = $1) AS first_request,
         (SELECT status FROM public.exchange_requests WHERE id = $2) AS second_request,
         (SELECT status FROM public.reservations WHERE request_id = $2) AS second_reservation,
         (SELECT availability FROM public.copies WHERE id = $3) AS second_copy,
         (SELECT count(*)::int FROM public.available_catalog WHERE copy_id = $3) AS second_catalog`,
      [first.id, second.id, copyIds[1]],
    );
    expect(state.rows[0]).toEqual({
      first_request: "cancelled",
      second_request: "pending",
      second_reservation: "active",
      second_copy: "reserved",
      second_catalog: 0,
    });
  });

  it("returns the same hold when the public form retries reservation with a new key", async () => {
    const request = await createRequest(copyIds[0]!, 140);
    const first = await database.query<{ reservation_id: string; expires_at: string }>(
      `SELECT * FROM public.reserve_copy($1, $2, decode($3,'hex'), $4)`,
      [copyIds[0], request.id, hex(145), uuid()],
    );
    const second = await database.query<{ reservation_id: string; expires_at: string }>(
      `SELECT * FROM public.reserve_copy($1, $2, decode($3,'hex'), $4)`,
      [copyIds[0], request.id, hex(145), uuid()],
    );
    expect(second.rows[0]!.reservation_id).toBe(first.rows[0]!.reservation_id);
    const count = await database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.reservations WHERE request_id = $1`,
      [request.id],
    );
    expect(count.rows[0]!.n).toBe(1);
  });

  it("handles two parallel request attempts for the same copy with one winner", async () => {
    const results = await Promise.allSettled([
      createRequest(copyIds[0]!, 120),
      createRequest(copyIds[0]!, 130),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "P0005" });

    const counts = await database.query<{ requests: number; reservations: number; reserved: number }>(
      `SELECT
         (SELECT count(*)::int FROM public.exchange_requests WHERE requested_copy_id = $1) AS requests,
         (SELECT count(*)::int FROM public.reservations WHERE copy_id = $1 AND status = 'active') AS reservations,
         (SELECT count(*)::int FROM public.copies WHERE id = $1 AND availability = 'reserved') AS reserved`,
      [copyIds[0]],
    );
    expect(counts.rows[0]).toEqual({ requests: 1, reservations: 1, reserved: 1 });
  });

  it("commits the hold on approval and keeps the copy out of the catalogue", async () => {
    const request = await createRequest(copyIds[0]!, 60);
    await moveToReview(request.id);
    await database.query(
      `SELECT public.set_request_status($1, 'approved', $2, $3)`,
      [request.id, reviewerId, ""],
    );

    const state = await database.query<{
      request_status: string;
      reservation_status: string;
      copy_availability: string;
      catalog: number;
    }>(
      `SELECT q.status AS request_status, r.status AS reservation_status,
              c.availability AS copy_availability,
              (SELECT count(*)::int FROM public.available_catalog WHERE copy_id = c.id) AS catalog
       FROM public.exchange_requests q
       JOIN public.reservations r ON r.request_id = q.id
       JOIN public.copies c ON c.id = r.copy_id
       WHERE q.id = $1`,
      [request.id],
    );
    expect(state.rows[0]).toEqual({
      request_status: "approved",
      reservation_status: "converted",
      copy_availability: "reserved",
      catalog: 0,
    });

    await expect(createRequest(copyIds[0]!, 70)).rejects.toMatchObject({ code: "P0005" });
  });

  it("releases only the rejected request hold and restores the catalogue", async () => {
    const request = await createRequest(copyIds[1]!, 80);
    await moveToReview(request.id);
    await database.query(
      `SELECT public.set_request_status($1, 'rejected', $2, $3)`,
      [request.id, reviewerId, "Documentación incompleta"],
    );

    const state = await database.query<{
      request_status: string;
      reservation_status: string;
      copy_availability: string;
      catalog: number;
      reason: string;
    }>(
      `SELECT q.status AS request_status, r.status AS reservation_status,
              c.availability AS copy_availability,
              (SELECT count(*)::int FROM public.available_catalog WHERE copy_id = c.id) AS catalog,
              (SELECT reason FROM public.request_status_history WHERE request_id = q.id ORDER BY id DESC LIMIT 1) AS reason
       FROM public.exchange_requests q
       JOIN public.reservations r ON r.request_id = q.id
       JOIN public.copies c ON c.id = r.copy_id
       WHERE q.id = $1`,
      [request.id],
    );
    expect(state.rows[0]).toEqual({
      request_status: "rejected",
      reservation_status: "released",
      copy_availability: "available",
      catalog: 1,
      reason: "Documentación incompleta",
    });
  });

  it("cancels an approved request before scheduling and returns the copy", async () => {
    const request = await createRequest(copyIds[2]!, 45);
    await moveToReview(request.id);
    await database.query(
      `SELECT public.set_request_status($1, 'approved', $2, $3)`,
      [request.id, reviewerId, ""],
    );
    await database.query(
      `SELECT public.set_request_status($1, 'cancelled', $2, $3)`,
      [request.id, reviewerId, "Cancelada antes de programar"],
    );

    const state = await database.query<{
      request_status: string;
      reservation_status: string;
      copy_availability: string;
      catalog: number;
    }>(
      `SELECT q.status AS request_status, r.status AS reservation_status,
              c.availability AS copy_availability,
              (SELECT count(*)::int FROM public.available_catalog WHERE copy_id = c.id) AS catalog
       FROM public.exchange_requests q
       JOIN public.reservations r ON r.request_id = q.id
       JOIN public.copies c ON c.id = r.copy_id
       WHERE q.id = $1`,
      [request.id],
    );
    expect(state.rows[0]).toEqual({
      request_status: "cancelled",
      reservation_status: "released",
      copy_availability: "available",
      catalog: 1,
    });
  });

  it("expires an undecided request and prevents a later approval", async () => {
    const request = await createRequest(copyIds[2]!, 90);
    await moveToReview(request.id);
    await database.query(
      `UPDATE public.reservations
       SET created_at = clock_timestamp() - interval '2 minutes',
           expires_at = clock_timestamp() - interval '1 minute'
       WHERE request_id = $1`,
      [request.id],
    );

    const processed = await database.query<{ count: number }>(
      `SELECT public.expire_reservations($1, 100) AS count`,
      [reviewerId],
    );
    expect(processed.rows[0]!.count).toBe(1);

    const state = await database.query<{ status: string; reservation_status: string; copy_availability: string }>(
      `SELECT q.status, r.status AS reservation_status, c.availability AS copy_availability
       FROM public.exchange_requests q
       JOIN public.reservations r ON r.request_id = q.id
       JOIN public.copies c ON c.id = r.copy_id
       WHERE q.id = $1`,
      [request.id],
    );
    expect(state.rows[0]).toEqual({
      status: "cancelled",
      reservation_status: "expired",
      copy_availability: "available",
    });

    await expect(database.query(
      `SELECT public.set_request_status($1, 'approved', $2, $3)`,
      [request.id, reviewerId, ""],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses to approve an expired reservation without changing the copy", async () => {
    const request = await createRequest(copyIds[3]!, 100);
    await moveToReview(request.id);
    await database.query(
      `UPDATE public.reservations
       SET created_at = clock_timestamp() - interval '2 minutes',
           expires_at = clock_timestamp() - interval '1 minute'
       WHERE request_id = $1`,
      [request.id],
    );

    await expect(database.query(
      `SELECT public.set_request_status($1, 'approved', $2, $3)`,
      [request.id, reviewerId, ""],
    )).rejects.toMatchObject({ code: "P0004" });

    const state = await database.query<{ status: string; reservation_status: string; copy_availability: string }>(
      `SELECT q.status, r.status AS reservation_status, c.availability AS copy_availability
       FROM public.exchange_requests q
       JOIN public.reservations r ON r.request_id = q.id
       JOIN public.copies c ON c.id = r.copy_id
       WHERE q.id = $1`,
      [request.id],
    );
    expect(state.rows[0]).toEqual({
      status: "under_review",
      reservation_status: "active",
      copy_availability: "reserved",
    });
  });

  it("records reservation audit events and exposes no personal data in the public catalogue", async () => {
    const request = await createRequest(copyIds[0]!, 110);
    await moveToReview(request.id);
    await database.query(
      `SELECT public.set_request_status($1, 'approved', $2, $3)`,
      [request.id, reviewerId, ""],
    );
    const audit = await database.query<{ event_type: string }>(
      `SELECT event_type FROM public.audit_events
       WHERE resource_type = 'reservation' OR event_type LIKE 'request.%'
       ORDER BY id`,
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual(
      expect.arrayContaining(["request.status_changed", "reservation.committed"]),
    );

    const columns = await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='available_catalog'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).not.toEqual(expect.arrayContaining(["full_name", "email", "participant_id"]));
    expect(request.id).toBeGreaterThan(0);
  });
});
