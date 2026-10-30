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

describe("plan exchange with proposed delivery date", () => {
  let database: PGlite;
  let managerId: number;
  let reviewerId: number;
  let plannerId: number;
  let copyIds: number[];

  beforeEach(async () => {
    database = await createDatabase();

    async function createActor(permissions: string[]): Promise<number> {
      const user = await database.query<{ id: string }>(
        `INSERT INTO public.app_users (identity_issuer, identity_subject)
         VALUES ('https://issuer.test', $1) RETURNING id`,
        [`qa-plan-${uuid()}`],
      );
      const userId = Number(user.rows[0]!.id);
      const role = await database.query<{ id: string }>(
        `INSERT INTO public.roles (role_key, display_name)
         VALUES ($1, $1) RETURNING id`,
        [`qa_plan_role_${userId}`],
      );
      const roleId = Number(role.rows[0]!.id);
      await database.query(
        `INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)`,
        [userId, roleId],
      );
      for (const permission of permissions) {
        await database.query(
          `INSERT INTO public.role_permissions (role_id, permission_id)
           SELECT $1, id FROM public.permissions WHERE permission_key = $2`,
          [roleId, permission],
        );
      }
      return userId;
    }

    managerId = await createActor([
      "requests.review",
      "exchange.plan",
      "delivery.schedule",
      "delivery.confirm",
    ]);
    reviewerId = await createActor(["requests.review"]);
    plannerId = await createActor(["requests.review", "exchange.plan"]);

    await database.query(
      `INSERT INTO public.privacy_notices (version, content_sha256, approved_at)
       VALUES ('notice-qa-plan', decode(repeat('bb',32),'hex'), clock_timestamp())`,
    );
    await database.query(
      `INSERT INTO public.reservation_policy (policy_id, duration_seconds, updated_by)
       VALUES (1, 3600, $1)`,
      [managerId],
    );
    await database.query(
      `INSERT INTO public.publishers (name, normalized_name)
       VALUES ('QA Plan Publisher','qa-plan-publisher')`,
    );
    await database.query(
      `INSERT INTO public.genres (name, normalized_name)
       VALUES ('QA Plan Genre','qa-plan-genre')`,
    );
    await database.query(
      `INSERT INTO public.bibliographic_records (title, author, publisher_id, genre_id)
       SELECT 'QA Plan Book','QA Author',p.id,g.id
       FROM public.publishers p, public.genres g
       WHERE p.normalized_name='qa-plan-publisher' AND g.normalized_name='qa-plan-genre'`,
    );
    const copies = await database.query<{ id: string }>(
      `INSERT INTO public.copies
         (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
       SELECT id, 'QA-PLAN-' || value, 'good', 'available', 'preexisting'
       FROM public.bibliographic_records,
            (VALUES ('1'),('2'),('3'),('4'),('5'),('6'),('7'),('8')) AS values(value)
       WHERE title='QA Plan Book'
       RETURNING id`,
    );
    copyIds = copies.rows.map((row) => Number(row.id));
    expect(copyIds).toHaveLength(8);
  });

  afterEach(async () => {
    await database.close();
  });

  async function createRequest(copyId: number, byte: number) {
    const accessHash = hex(byte + 5);
    const rows = await database.query<{ request_id: string; request_code: string }>(
      `SELECT * FROM public.create_exchange_request($1, $2::jsonb, $3)`,
      [
        `QA-PLAN-${byte}`,
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
          consent: { noticeVersion: "notice-qa-plan", evidenceSha256: hex(byte + 4) },
          request: { requestedCopyId: copyId, accessTokenSha256: accessHash },
          offeredBook: {
            title: `QA Offered Plan ${byte}`,
            author: "QA Author",
            publisherClaim: "QA Plan Publisher",
            genreClaim: "QA Plan Genre",
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

  async function approve(requestId: number) {
    await database.query(
      `SELECT public.set_request_status($1, 'under_review', $2, '')`,
      [requestId, managerId],
    );
    await database.query(
      `SELECT public.set_request_status($1, 'approved', $2, '')`,
      [requestId, managerId],
    );
  }

  async function localNoon(offsetDays = 0): Promise<string> {
    const rows = await database.query<{ scheduled_at: string }>(
      `SELECT ((clock_timestamp() AT TIME ZONE 'America/Bogota')::date + $1::int + time '12:00')
              AT TIME ZONE 'America/Bogota' AS scheduled_at`,
      [offsetDays],
    );
    return rows.rows[0]!.scheduled_at;
  }

  async function plan(
    requestId: number,
    scheduledAt: string,
    planningKey = uuid(),
    actorId = managerId,
  ) {
    const rows = await database.query<{
      exchange_id: string;
      reception_id: string;
      delivery_id: string;
      delivery_scheduled_at: string;
    }>(
      `SELECT * FROM public.plan_exchange_with_dropoff($1, $2, $3, $4)`,
      [requestId, scheduledAt, planningKey, actorId],
    );
    return rows.rows[0]!;
  }

  async function confirm(deliveryId: string | number, idempotencyKey: string, actorId = managerId) {
    return database.query<{ confirm_delivery: string }>(
      `SELECT public.confirm_delivery($1, $2, 'QA-RECEIPT', 'QA plan test', $3)`,
      [deliveryId, actorId, idempotencyKey],
    );
  }

  it("plans today without a receipt code and confirms the physical delivery explicitly", async () => {
    const request = await createRequest(copyIds[0]!, 20);
    await approve(request.id);
    const scheduledAt = await localNoon(0);
    const planned = await plan(request.id, scheduledAt);

    const reception = await database.query<{
      receipt_code: string | null;
      status: string;
    }>(`SELECT receipt_code, status FROM public.receptions WHERE id=$1`, [planned.reception_id]);
    expect(reception.rows[0]).toEqual({ receipt_code: null, status: "awaiting_delivery" });

    const delivery = await database.query<{
      status: string;
      scheduled_at: string;
      idempotency_key: string;
    }>(`SELECT status, scheduled_at, idempotency_key FROM public.deliveries WHERE id=$1`, [planned.delivery_id]);
    expect(delivery.rows[0]!.status).toBe("scheduled");
    expect(new Date(delivery.rows[0]!.scheduled_at).toISOString()).toBe(new Date(scheduledAt).toISOString());

    const state = await database.query<{
      request_status: string;
      exchange_status: string;
      reservation_status: string;
      copy_availability: string;
    }>(
      `SELECT q.status AS request_status, e.status AS exchange_status,
              r.status AS reservation_status, c.availability AS copy_availability
       FROM public.exchange_requests q
       JOIN public.exchanges e ON e.request_id=q.id
       JOIN public.reservations r ON r.request_id=q.id
       JOIN public.copies c ON c.id=r.copy_id
       WHERE q.id=$1`,
      [request.id],
    );
    expect(state.rows[0]).toEqual({
      request_status: "scheduled",
      exchange_status: "planned",
      reservation_status: "converted",
      copy_availability: "reserved",
    });

    await confirm(planned.delivery_id, delivery.rows[0]!.idempotency_key);

    const after = await database.query<{
      delivery_status: string;
      reception_status: string;
      exchange_status: string;
    }>(
      `SELECT d.status AS delivery_status, rec.status AS reception_status, e.status AS exchange_status
       FROM public.deliveries d
       JOIN public.receptions rec ON rec.id=d.reception_id
       JOIN public.exchanges e ON e.id=d.exchange_id
       WHERE d.id=$1`,
      [planned.delivery_id],
    );
    expect(after.rows[0]).toEqual({
      delivery_status: "completed",
      reception_status: "received",
      exchange_status: "planned",
    });
  });

  it("blocks early confirmation for a future date and enables it when the date arrives", async () => {
    const request = await createRequest(copyIds[1]!, 30);
    await approve(request.id);
    const planned = await plan(request.id, await localNoon(1));
    const delivery = await database.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM public.deliveries WHERE id=$1`,
      [planned.delivery_id],
    );

    await expect(
      confirm(planned.delivery_id, delivery.rows[0]!.idempotency_key),
    ).rejects.toMatchObject({ code: "23514" });

    const stillScheduled = await database.query<{ status: string }>(
      `SELECT status FROM public.deliveries WHERE id=$1`,
      [planned.delivery_id],
    );
    expect(stillScheduled.rows[0]!.status).toBe("scheduled");

    // Simulate the arrival of the scheduled day without touching the real DB.
    await database.query(
      `UPDATE public.deliveries SET scheduled_at=$1 WHERE id=$2`,
      [await localNoon(0), planned.delivery_id],
    );
    await confirm(planned.delivery_id, delivery.rows[0]!.idempotency_key);

    const completed = await database.query<{ status: string }>(
      `SELECT status FROM public.deliveries WHERE id=$1`,
      [planned.delivery_id],
    );
    expect(completed.rows[0]!.status).toBe("completed");
  });

  it("allows a past date to be confirmed late but never marks it delivered automatically", async () => {
    const request = await createRequest(copyIds[2]!, 40);
    await approve(request.id);
    const planned = await plan(request.id, await localNoon(-1));
    const delivery = await database.query<{ status: string; idempotency_key: string }>(
      `SELECT status, idempotency_key FROM public.deliveries WHERE id=$1`,
      [planned.delivery_id],
    );
    expect(delivery.rows[0]!.status).toBe("scheduled");

    await confirm(planned.delivery_id, delivery.rows[0]!.idempotency_key);
    const after = await database.query<{ status: string }>(
      `SELECT status FROM public.deliveries WHERE id=$1`,
      [planned.delivery_id],
    );
    expect(after.rows[0]!.status).toBe("completed");
  });

  it("keeps planning idempotent and preserves the first proposed date", async () => {
    const request = await createRequest(copyIds[3]!, 50);
    await approve(request.id);
    const key = uuid();
    const firstDate = await localNoon(0);
    const first = await plan(request.id, firstDate, key);
    const second = await plan(request.id, await localNoon(1), key);

    expect(second.exchange_id).toBe(first.exchange_id);
    expect(second.reception_id).toBe(first.reception_id);
    expect(second.delivery_id).toBe(first.delivery_id);
    expect(new Date(second.delivery_scheduled_at).toISOString()).toBe(new Date(firstDate).toISOString());

    const counts = await database.query<{ exchanges: number; deliveries: number; receptions: number }>(
      `SELECT
         (SELECT count(*)::int FROM public.exchanges WHERE request_id=$1) AS exchanges,
         (SELECT count(*)::int FROM public.deliveries WHERE exchange_id=$2) AS deliveries,
         (SELECT count(*)::int FROM public.receptions WHERE request_id=$1) AS receptions`,
      [request.id, first.exchange_id],
    );
    expect(counts.rows[0]).toEqual({ exchanges: 1, deliveries: 1, receptions: 1 });

    const other = await createRequest(copyIds[4]!, 60);
    await approve(other.id);
    await expect(plan(other.id, firstDate, key)).rejects.toMatchObject({ code: "23505" });
  });

  it("does not duplicate a delivery when confirmation is repeated", async () => {
    const request = await createRequest(copyIds[5]!, 70);
    await approve(request.id);
    const planned = await plan(request.id, await localNoon(0));
    const delivery = await database.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM public.deliveries WHERE id=$1`,
      [planned.delivery_id],
    );

    await confirm(planned.delivery_id, delivery.rows[0]!.idempotency_key);
    const replay = await confirm(planned.delivery_id, delivery.rows[0]!.idempotency_key);
    expect(Number(replay.rows[0]!.confirm_delivery)).toBe(Number(planned.delivery_id));

    await expect(
      confirm(planned.delivery_id, uuid()),
    ).rejects.toMatchObject({ code: "23505" });

    const count = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.deliveries
       WHERE exchange_id=$1 AND delivery_type='offered_book_dropoff'`,
      [planned.exchange_id],
    );
    expect(count.rows[0]!.count).toBe(1);
  });

  it("keeps the existing administrative permission checks", async () => {
    const request = await createRequest(copyIds[6]!, 80);
    await approve(request.id);

    await expect(plan(request.id, await localNoon(0), uuid(), reviewerId))
      .rejects.toMatchObject({ code: "42501" });
    await expect(plan(request.id, await localNoon(0), uuid(), plannerId))
      .rejects.toMatchObject({ code: "42501" });

    const planned = await plan(request.id, await localNoon(0));
    const delivery = await database.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM public.deliveries WHERE id=$1`,
      [planned.delivery_id],
    );
    await expect(confirm(planned.delivery_id, delivery.rows[0]!.idempotency_key, reviewerId))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("keeps historical manual receipt codes and the old planning entry point compatible", async () => {
    const column = await database.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='receptions' AND column_name='receipt_code'`,
    );
    expect(column.rows[0]).toEqual({ is_nullable: "YES", column_default: null });

    const request = await createRequest(copyIds[7]!, 90);
    await approve(request.id);
    const key = uuid();
    const planned = await database.query<{ exchange_id: string; reception_id: string }>(
      `SELECT * FROM public.plan_exchange($1, $2, $3, $4)`,
      [request.id, "LEGACY-QA-CODE", key, managerId],
    );
    const reception = await database.query<{ receipt_code: string | null }>(
      `SELECT receipt_code FROM public.receptions WHERE id=$1`,
      [planned.rows[0]!.reception_id],
    );
    expect(reception.rows[0]!.receipt_code).toBe("LEGACY-QA-CODE");

    const deliveryId = await database.query<{ schedule_delivery: string }>(
      `SELECT public.schedule_delivery($1, 'offered_book_dropoff', $2, $3, $4)`,
      [planned.rows[0]!.exchange_id, await localNoon(0), uuid(), managerId],
    );
    const delivery = await database.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM public.deliveries WHERE id=$1`,
      [deliveryId.rows[0]!.schedule_delivery],
    );
    await confirm(deliveryId.rows[0]!.schedule_delivery, delivery.rows[0]!.idempotency_key);
    const completed = await database.query<{ status: string }>(
      `SELECT status FROM public.deliveries WHERE id=$1`,
      [deliveryId.rows[0]!.schedule_delivery],
    );
    expect(completed.rows[0]!.status).toBe("completed");
  });

  it("compares the boundary in America/Bogota, not UTC", async () => {
    const boundary = await database.query<{
      today_late: string;
      tomorrow_early: string;
    }>(
      `SELECT
         ((clock_timestamp() AT TIME ZONE 'America/Bogota')::date + time '23:30')
           AT TIME ZONE 'America/Bogota' AS today_late,
         ((clock_timestamp() AT TIME ZONE 'America/Bogota')::date + 1 + time '00:30')
           AT TIME ZONE 'America/Bogota' AS tomorrow_early`,
    );
    const todayLate = boundary.rows[0]!.today_late;
    const tomorrowEarly = boundary.rows[0]!.tomorrow_early;

    const lateRequest = await createRequest(copyIds[0]!, 100);
    await approve(lateRequest.id);
    const latePlan = await plan(lateRequest.id, todayLate);
    const lateDelivery = await database.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM public.deliveries WHERE id=$1`,
      [latePlan.delivery_id],
    );
    await confirm(latePlan.delivery_id, lateDelivery.rows[0]!.idempotency_key);

    const earlyRequest = await createRequest(copyIds[1]!, 110);
    await approve(earlyRequest.id);
    const earlyPlan = await plan(earlyRequest.id, tomorrowEarly);
    const earlyDelivery = await database.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM public.deliveries WHERE id=$1`,
      [earlyPlan.delivery_id],
    );
    await expect(
      confirm(earlyPlan.delivery_id, earlyDelivery.rows[0]!.idempotency_key),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
