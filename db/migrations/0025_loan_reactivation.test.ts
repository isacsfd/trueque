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
  "0014_admin_runtime_grants.sql",
  "0015_release_expired_reservations.sql",
  "0016_reservation_lifecycle.sql",
  "0017_public_request_status.sql",
  "0018_plan_exchange_delivery.sql",
  "0024_loans.sql",
  "0025_loan_reactivation.sql",
];

const hex = (byte: number) => Buffer.alloc(32, byte).toString("hex");

async function migrationText(name: string): Promise<string> {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

describe("0025 cancelled loan reactivation", () => {
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
    for (const name of migrations) {
      await database.exec(await migrationText(name));
    }

    const user = await database.query<{ id: string }>(
      `INSERT INTO public.app_users (identity_issuer, identity_subject)
       VALUES ('https://test', 'loan-reactivator') RETURNING id`,
    );
    actorId = Number(user.rows[0]!.id);
    const role = await database.query<{ id: string }>(
      `INSERT INTO public.roles (role_key, display_name)
       VALUES ('loan_reactivation_test', 'Loan reactivation test') RETURNING id`,
    );
    const roleId = Number(role.rows[0]!.id);
    await database.query("INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)", [actorId, roleId]);
    await database.query(
      `INSERT INTO public.role_permissions (role_id, permission_id)
       SELECT $1, id FROM public.permissions
       WHERE permission_key IN (
         'requests.review', 'reservations.configure', 'reservations.expire', 'loans.reactivate'
       )`,
      [roleId],
    );

    await database.query(
      `INSERT INTO public.privacy_notices (version, content_sha256, approved_at)
       VALUES ('notice-loans', decode(repeat('31',32),'hex'), clock_timestamp())`,
    );
    await database.query("SELECT public.set_reservation_policy(172800, $1)", [actorId]);
    await database.query(
      `INSERT INTO public.publishers (name, normalized_name)
       VALUES ('Loan Publisher','loan-publisher')`,
    );
    await database.query(
      `INSERT INTO public.genres (name, normalized_name)
       VALUES ('Loan Genre','loan-genre')`,
    );
    const bib = await database.query<{ id: string }>(
      `INSERT INTO public.bibliographic_records (title, author, publisher_id, genre_id)
       SELECT 'Loan Book','Loan Author',p.id,g.id
       FROM public.publishers p, public.genres g
       WHERE p.normalized_name='loan-publisher' AND g.normalized_name='loan-genre'
       RETURNING id`,
    );
    const copy = await database.query<{ id: string }>(
      `INSERT INTO public.copies
         (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
       VALUES ($1, 'LOAN-REACT-001', 'good', 'available', 'preexisting') RETURNING id`,
      [Number(bib.rows[0]!.id)],
    );
    copyId = Number(copy.rows[0]!.id);
  });

  afterEach(async () => {
    await database.close();
  });

  async function createRequest(): Promise<{ id: number; code: string }> {
    const payload = {
      participant: {
        fullNameCiphertext: hex(40),
        fullNameKeyVersion: 1,
        emailCiphertext: hex(41),
        emailKeyVersion: 1,
        identityCiphertext: hex(42),
        identityKeyVersion: 1,
        identityFingerprint: hex(43),
        hmacKeyVersion: 1,
      },
      consent: {
        noticeVersion: "notice-loans",
        evidenceSha256: hex(44),
      },
      request: {
        requestedCopyId: copyId,
        accessTokenSha256: hex(45),
      },
      offeredBook: {
        title: "Offered loan book",
        author: "Loan author",
        publisherClaim: "Loan Publisher",
        genreClaim: "Loan Genre",
        isbn: null,
        isbnNormalized: null,
        declaredCondition: "good",
        observations: null,
      },
    };
    const rows = await database.query<{ request_id: string; request_code: string }>(
      `SELECT * FROM public.create_exchange_request($1, $2::jsonb, $3)`,
      [`LOAN-REACT-${Date.now()}-${Math.random()}`, JSON.stringify(payload), crypto.randomUUID()],
    );
    return { id: Number(rows.rows[0]!.request_id), code: rows.rows[0]!.request_code };
  }

  async function cancelLoan(): Promise<{ loanId: number; requestId: number }> {
    const request = await createRequest();
    await database.query("SELECT public.set_request_status($1, 'under_review', $2, 'review')", [request.id, actorId]);
    await database.query("SELECT public.set_request_status($1, 'approved', $2, 'approved')", [request.id, actorId]);
    await database.query("SELECT public.set_request_status($1, 'cancelled', $2, 'cancelado por prueba')", [request.id, actorId]);
    const rows = await database.query<{ id: string }>(
      "SELECT id FROM public.loans WHERE request_id = $1",
      [request.id],
    );
    return { loanId: Number(rows.rows[0]!.id), requestId: request.id };
  }

  async function loanState(loanId: number) {
    const rows = await database.query<{
      status: string;
      request_status: string;
      copy_availability: string;
      reservation_status: string;
      due_at: Date;
      events: number;
      event_statuses: string[];
    }>(
      `SELECT l.status, r.status AS request_status, c.availability AS copy_availability,
              res.status AS reservation_status, l.due_at,
              ev.events,
              ev.event_statuses
       FROM public.loans l
       JOIN public.exchange_requests r ON r.id = l.request_id
       JOIN public.copies c ON c.id = l.copy_id
       JOIN public.reservations res ON res.id = l.reservation_id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS events,
                array_agg(le.new_status ORDER BY le.id) AS event_statuses
         FROM public.loan_events le
         WHERE le.loan_id = l.id
       ) ev ON TRUE
       WHERE l.id = $1`,
      [loanId],
    );
    return rows.rows[0];
  }

  it("reactivates a cancelled loan, preserves history and restores a 48 hour reservation", async () => {
    const { loanId, requestId } = await cancelLoan();
    const before = await loanState(loanId);
    expect(before).toMatchObject({ status: "cancelled", request_status: "cancelled", copy_availability: "available" });
    expect(before!.event_statuses).toContain("cancelled");

    const result = await database.query<{ loan_id: string; status: string; due_at: Date }>(
      "SELECT * FROM public.reactivate_cancelled_loan($1, $2, $3, $4)",
      [loanId, "Reactivación autorizada", crypto.randomUUID(), actorId],
    );
    expect(result.rows[0]).toMatchObject({ loan_id: loanId, status: "reserved" });

    const after = await loanState(loanId);
    expect(after).toMatchObject({
      status: "reserved",
      request_status: "under_review",
      copy_availability: "reserved",
      reservation_status: "active",
    });
    expect(after!.event_statuses).toContain("cancelled");
    expect(after!.event_statuses).toContain("reserved");
    expect(new Date(after!.due_at).getTime() - Date.now())
      .toBeGreaterThanOrEqual(172_800_000 - 60_000);

    const histories = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM public.request_status_history
       WHERE request_id = $1 AND previous_status = 'cancelled' AND new_status = 'under_review'`,
      [requestId],
    );
    expect(histories.rows[0]?.count).toBe(1);
  });

  it("is idempotent for the same reactivation key", async () => {
    const { loanId } = await cancelLoan();
    const key = crypto.randomUUID();
    await database.query("SELECT * FROM public.reactivate_cancelled_loan($1, $2, $3, $4)", [
      loanId, "Reactivación autorizada", key, actorId,
    ]);
    const before = await loanState(loanId);

    await database.query("SELECT * FROM public.reactivate_cancelled_loan($1, $2, $3, $4)", [
      loanId, "Reactivación autorizada", key, actorId,
    ]);
    const after = await loanState(loanId);

    expect(after).toMatchObject({
      status: before!.status,
      reservation_status: before!.reservation_status,
      events: before!.events,
    });
  });

  it("rejects reactivation when the copy has another active loan", async () => {
    const { loanId } = await cancelLoan();
    await createRequest();

    await expect(
      database.query("SELECT * FROM public.reactivate_cancelled_loan($1, $2, $3, $4)", [
        loanId, "Reactivación autorizada", crypto.randomUUID(), actorId,
      ]),
    ).rejects.toThrow(/another active loan|another active reservation/i);

    const state = await loanState(loanId);
    expect(state).toMatchObject({ status: "cancelled", copy_availability: "reserved" });
  });

  it("rejects retired copies and pending physical returns without partial changes", async () => {
    const { loanId } = await cancelLoan();

    await database.query("UPDATE public.copies SET availability = 'retired' WHERE id = $1", [copyId]);
    await expect(
      database.query("SELECT * FROM public.reactivate_cancelled_loan($1, $2, $3, $4)", [
        loanId, "Reactivación autorizada", crypto.randomUUID(), actorId,
      ]),
    ).rejects.toThrow(/retired/i);

    await database.query("UPDATE public.copies SET availability = 'available' WHERE id = $1", [copyId]);
    const loanRow = await database.query<{ request_id: string }>(
      "SELECT request_id FROM public.loans WHERE id = $1", [loanId],
    );
    await database.query(
      `INSERT INTO public.deliveries
         (request_id, delivery_type, status, recorded_by, idempotency_key)
       VALUES ($1, 'offered_book_return', 'scheduled', $2, $3)`,
      [loanRow.rows[0]!.request_id, actorId, crypto.randomUUID()],
    );

    await expect(
      database.query("SELECT * FROM public.reactivate_cancelled_loan($1, $2, $3, $4)", [
        loanId, "Reactivación autorizada", crypto.randomUUID(), actorId,
      ]),
    ).rejects.toThrow(/pending or confirmed physical return/i);

    const state = await loanState(loanId);
    expect(state).toMatchObject({ status: "cancelled", copy_availability: "available" });
  });

  it("restores an expired reservation with at least 48 hours", async () => {
    const { loanId } = await cancelLoan();
    await database.query(
      `UPDATE public.reservations
       SET status = 'expired', released_at = clock_timestamp()
       WHERE id = (SELECT reservation_id FROM public.loans WHERE id = $1)`,
      [loanId],
    );

    await database.query("SELECT * FROM public.reactivate_cancelled_loan($1, $2, $3, $4)", [
      loanId, "Reactivación autorizada", crypto.randomUUID(), actorId,
    ]);

    const reservation = await database.query<{ status: string; duration_ms: number }>(
      `SELECT r.status,
              (extract(epoch FROM (r.expires_at - r.created_at)) * 1000)::bigint AS duration_ms
       FROM public.reservations r
       WHERE r.id = (SELECT reservation_id FROM public.loans WHERE id = $1)`,
      [loanId],
    );
    expect(reservation.rows[0]).toMatchObject({ status: "active" });
    expect(Number(reservation.rows[0]!.duration_ms)).toBeGreaterThanOrEqual(172_800_000);
  });

  it("requires the administrative reactivation permission", async () => {
    const { loanId } = await cancelLoan();
    const limited = await database.query<{ id: string }>(
      `INSERT INTO public.app_users (identity_issuer, identity_subject)
       VALUES ('https://test', 'limited-loan-actor') RETURNING id`,
    );
    const limitedId = Number(limited.rows[0]!.id);
    const role = await database.query<{ id: string }>(
      `INSERT INTO public.roles (role_key, display_name)
       VALUES ('limited_loan_role', 'Limited loan role') RETURNING id`,
    );
    const roleId = Number(role.rows[0]!.id);
    await database.query("INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)", [limitedId, roleId]);
    await database.query(
      `INSERT INTO public.role_permissions (role_id, permission_id)
       SELECT $1, id FROM public.permissions WHERE permission_key = 'requests.review'`,
      [roleId],
    );

    await expect(
      database.query("SELECT * FROM public.reactivate_cancelled_loan($1, $2, $3, $4)", [
        loanId, "Reactivación autorizada", crypto.randomUUID(), limitedId,
      ]),
    ).rejects.toThrow();

    const state = await loanState(loanId);
    expect(state).toMatchObject({ status: "cancelled", copy_availability: "available" });
  });
});
