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
];

const uuid = () => crypto.randomUUID();
const hex = (byte: number) => Buffer.alloc(32, byte).toString("hex");

async function migrationText(name: string): Promise<string> {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

describe("0024 loan history and 48 hour policy", () => {
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
       VALUES ('https://test', 'loan-reviewer') RETURNING id`,
    );
    actorId = Number(user.rows[0]!.id);
    const role = await database.query<{ id: string }>(
      `INSERT INTO public.roles (role_key, display_name)
       VALUES ('loan_reviewer_test', 'Loan reviewer test') RETURNING id`,
    );
    const roleId = Number(role.rows[0]!.id);
    await database.query("INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)", [actorId, roleId]);
    await database.query(
      `INSERT INTO public.role_permissions (role_id, permission_id)
       SELECT $1, id FROM public.permissions
       WHERE permission_key IN (
         'requests.review', 'reservations.configure', 'reservations.expire'
       )`,
      [roleId],
    );

    await database.query(
      `INSERT INTO public.privacy_notices (version, content_sha256, approved_at)
       VALUES ('notice-loans', decode(repeat('21',32),'hex'), clock_timestamp())`,
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
       VALUES ($1, 'LOAN-001', 'good', 'available', 'preexisting') RETURNING id`,
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
        fullNameCiphertext: hex(30),
        fullNameKeyVersion: 1,
        emailCiphertext: hex(31),
        emailKeyVersion: 1,
        identityCiphertext: hex(32),
        identityKeyVersion: 1,
        identityFingerprint: hex(33),
        hmacKeyVersion: 1,
      },
      consent: {
        noticeVersion: "notice-loans",
        evidenceSha256: hex(34),
      },
      request: {
        requestedCopyId: copyId,
        accessTokenSha256: hex(35),
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
      [`LOAN-${Date.now()}`, JSON.stringify(payload), uuid()],
    );
    return { id: Number(rows.rows[0]!.request_id), code: rows.rows[0]!.request_code };
  }

  async function loan(requestId: number) {
    const rows = await database.query<{
      id: number;
      status: string;
      started_at: Date;
      due_at: Date;
      closed_at: Date | null;
      closed_by: number | null;
      copy_availability: string;
      events: number;
    }>(
      `SELECT l.id, l.status, l.started_at, l.due_at, l.closed_at, l.closed_by,
              c.availability AS copy_availability,
              (SELECT count(*)::int FROM public.loan_events le WHERE le.loan_id = l.id) AS events
       FROM public.loans l
       JOIN public.copies c ON c.id = l.copy_id
       WHERE l.request_id = $1`,
      [requestId],
    );
    return rows.rows[0];
  }

  it("rejects reservation policies below 48 hours", async () => {
    await expect(
      database.query("SELECT public.set_reservation_policy(172800 - 1, $1)", [actorId]),
    ).rejects.toThrow(/at least 48 hours/i);

    const policy = await database.query<{ duration_seconds: number }>(
      "SELECT duration_seconds FROM public.reservation_policy WHERE policy_id = 1",
    );
    expect(policy.rows[0]?.duration_seconds).toBe(172800);
  });

  it("creates the loan on reservation and preserves a 48 hour minimum", async () => {
    const request = await createRequest();
    const current = await loan(request.id);
    expect(current).toBeTruthy();
    expect(current!.status).toBe("reserved");
    expect(current!.copy_availability).toBe("reserved");
    expect(new Date(current!.due_at).getTime() - new Date(current!.started_at).getTime())
      .toBeGreaterThanOrEqual(172_800_000);

    const expired = await database.query<{ count: number }>(
      "SELECT public.expire_reservations($1, 100) AS count",
      [actorId],
    );
    expect(Number(expired.rows[0]?.count)).toBe(0);

    const stillOpen = await loan(request.id);
    expect(stillOpen).toMatchObject({ status: "reserved", copy_availability: "reserved" });
  });

  it("closes the loan and restores availability on a valid cancellation", async () => {
    const request = await createRequest();
    await database.query("SELECT public.set_request_status($1, 'under_review', $2, 'review')", [request.id, actorId]);
    await database.query("SELECT public.set_request_status($1, 'approved', $2, 'approved')", [request.id, actorId]);
    expect(await loan(request.id)).toMatchObject({ status: "committed", copy_availability: "reserved" });

    await database.query("SELECT public.set_request_status($1, 'cancelled', $2, 'valid cancellation')", [request.id, actorId]);
    const closed = await loan(request.id);
    expect(closed).toMatchObject({
      status: "cancelled",
      closed_at: expect.any(Date),
      closed_by: actorId,
      copy_availability: "available",
    });
  });

  it("does not alter inventory or loan history on an invalid transition", async () => {
    const request = await createRequest();
    const before = await loan(request.id);

    await expect(
      database.query("SELECT public.set_request_status($1, 'cancelled', $2, 'invalid')", [request.id, actorId]),
    ).rejects.toThrow();

    const after = await loan(request.id);
    expect(after).toMatchObject({
      status: before!.status,
      closed_at: null,
      copy_availability: before!.copy_availability,
      events: before!.events,
    });
  });

  it("prevents duplicate close events on idempotent closures", async () => {
    const request = await createRequest();
    await database.query("SELECT public.set_request_status($1, 'under_review', $2, 'review')", [request.id, actorId]);
    await database.query("SELECT public.set_request_status($1, 'approved', $2, 'approved')", [request.id, actorId]);
    await database.query("SELECT public.set_request_status($1, 'cancelled', $2, 'valid cancellation')", [request.id, actorId]);
    const first = await loan(request.id);
    await database.query("SELECT public.set_request_status($1, 'cancelled', $2, 'valid cancellation')", [request.id, actorId]);
    const second = await loan(request.id);

    expect(second).toMatchObject({
      status: first!.status,
      closed_at: first!.closed_at,
      events: first!.events,
    });
    expect(second!.copy_availability).toBe("available");
  });
});
