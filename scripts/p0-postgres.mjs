import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";

const baseUrl = process.env.IUB_TEST_DATABASE_URL;
if (!baseUrl) {
  console.error("IUB_TEST_DATABASE_URL is required. Use a disposable PostgreSQL database; nothing was run.");
  process.exit(2);
}

const roleUrl = (role) => {
  const url = new URL(baseUrl);
  url.username = role;
  url.password = "";
  return url.toString();
};

const migrator = new Client({ connectionString: baseUrl });
const admin = new Client({ connectionString: roleUrl("iub_admin_runtime") });
const publicRuntime = new Client({ connectionString: roleUrl("iub_public_runtime") });
const publicTwo = new Client({ connectionString: roleUrl("iub_public_runtime") });
const blocker = new Client({ connectionString: roleUrl("iub_public_runtime") });
const adminTwo = new Client({ connectionString: roleUrl("iub_admin_runtime") });

const digest = (value) => createHash("sha256").update(`${runId}:${value}`).digest();
const runId = Date.now().toString(36);
let sequence = 0;
const next = () => ++sequence;
const uuid = () => randomUUID();

async function connectAll() {
  await Promise.all([
    migrator.connect(),
    admin.connect(),
    publicRuntime.connect(),
    publicTwo.connect(),
    blocker.connect(),
    adminTwo.connect(),
  ]);
}

async function closeAll() {
  await Promise.allSettled([
    migrator.end(),
    admin.end(),
    publicRuntime.end(),
    publicTwo.end(),
    blocker.end(),
    adminTwo.end(),
  ]);
}

async function expectPostgresError(promise, code) {
  try {
    await promise;
    assert.fail(`expected PostgreSQL error ${code}`);
  } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
  }
}

async function createActor(name, permissions) {
  const user = await migrator.query(
    `INSERT INTO public.app_users (identity_issuer, identity_subject)
     VALUES ('https://issuer.test', $1) RETURNING id`,
    [`${runId}-${name}-${next()}`],
  );
  const role = await migrator.query(
    `INSERT INTO public.roles (role_key, display_name) VALUES ($1, $1) RETURNING id`,
    [`${runId}_role_${next()}`],
  );
  const userId = Number(user.rows[0].id);
  const roleId = Number(role.rows[0].id);
  await migrator.query(
    "INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)",
    [userId, roleId],
  );
  for (const permission of permissions) {
    await migrator.query(
      `INSERT INTO public.role_permissions (role_id, permission_id)
       SELECT $1, id FROM public.permissions WHERE permission_key = $2`,
      [roleId, permission],
    );
  }
  return { id: userId, roleId };
}

async function seedBase() {
  await migrator.query(
    `INSERT INTO public.privacy_notices (version, content_sha256, approved_at)
     VALUES ('notice-2026-01', $1, clock_timestamp())
     ON CONFLICT (version) DO NOTHING`,
    [digest(80)],
  );
  const publisher = await migrator.query(
    `INSERT INTO public.publishers (name, normalized_name)
     VALUES ($1, $2) RETURNING id`,
    [`Editorial P0 ${runId}`, `editorial-p0-${runId}`],
  );
  const genre = await migrator.query(
    `INSERT INTO public.genres (name, normalized_name)
     VALUES ($1, $2) RETURNING id`,
    [`Ensayo P0 ${runId}`, `ensayo-p0-${runId}`],
  );
  const publisherId = Number(publisher.rows[0].id);
  const genreId = Number(genre.rows[0].id);

  const actor = {
    manager: await createActor("manager", [
      "requests.review", "reservations.configure", "reservations.expire",
      "exchange.plan", "exchange.start", "exchange.complete", "exchange.cancel",
      "delivery.schedule", "delivery.confirm", "inventory.admit", "inventory.enable",
      "reception.return",
    ]),
    receiver: await createActor("receiver", ["delivery.confirm", "custody.transfer"]),
    evaluator: await createActor("evaluator", ["reception.evaluate"]),
    validator: await createActor("validator", ["cataloging.validate"]),
    authorizer: await createActor("authorizer", ["cataloging.authorize"]),
  };

  await admin.query("SELECT public.set_reservation_policy(3600, $1)", [actor.manager.id]);

  return { actor, publisherId, genreId };
}

async function createInstitutionalCopy(base, label) {
  const bib = await migrator.query(
    `INSERT INTO public.bibliographic_records (title, author, publisher_id, genre_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [`Institutional ${runId} ${label}`, `Author ${label}`, base.publisherId, base.genreId],
  );
  const copy = await migrator.query(
    `INSERT INTO public.copies
       (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
     VALUES ($1, $2, 'good', 'available', 'preexisting') RETURNING id`,
    [Number(bib.rows[0].id), `IUB-${runId}-${label}`],
  );
  return { copyId: Number(copy.rows[0].id), bibId: Number(bib.rows[0].id) };
}

async function createRequest(copyId, label) {
  const suffix = next();
  const participant = await migrator.query(
    `INSERT INTO public.participants
       (full_name_ciphertext, full_name_key_version, email_ciphertext, email_key_version,
        identity_ciphertext, identity_key_version)
     VALUES ($1, 1, $2, 1, $3, 1) RETURNING id`,
    [Buffer.from(`name-${runId}-${label}`), Buffer.from(`email-${runId}-${label}`), Buffer.from(`id-${runId}-${label}`)],
  );
  const participantId = Number(participant.rows[0].id);
  const accessHash = digest(suffix + 10);
  await migrator.query(
    `INSERT INTO public.participant_document_fingerprints
       (participant_id, hmac_key_version, fingerprint) VALUES ($1, 1, $2)`,
    [participantId, digest(suffix + 40)],
  );
  const consent = await migrator.query(
    `INSERT INTO public.privacy_consents
       (participant_id, notice_version, purpose, consented_at, evidence_sha256,
        capture_channel, idempotency_key)
     VALUES ($1, 'notice-2026-01', 'book_exchange', clock_timestamp(), $2, 'web', $3)
     RETURNING id`,
    [participantId, digest(suffix + 70), uuid()],
  );
  const request = await migrator.query(
    `INSERT INTO public.exchange_requests
       (request_code, participant_id, requested_copy_id, privacy_consent_id,
        request_access_token_sha256, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [`REQUEST-${runId}-${label}-${suffix}`, participantId, copyId, Number(consent.rows[0].id), accessHash, uuid()],
  );
  const requestId = Number(request.rows[0].id);
  await migrator.query(
    `INSERT INTO public.offered_books (request_id, title, author, declared_condition)
     VALUES ($1, $2, $3, 'good')`,
    [requestId, `Offered ${runId} ${label}`, `Offered author ${label}`],
  );
  return { requestId, participantId, accessHash };
}

async function approve(requestId, actor) {
  await admin.query("SELECT public.set_request_status($1, 'under_review', $2, 'review')", [requestId, actor.manager.id]);
  await admin.query("SELECT public.set_request_status($1, 'approved', $2, 'approved')", [requestId, actor.manager.id]);
}

async function createReservedScenario(base, label) {
  const copy = await createInstitutionalCopy(base, label);
  const request = await createRequest(copy.copyId, label);
  const reservation = await publicRuntime.query(
    "SELECT * FROM public.reserve_copy($1, $2, $3, $4)",
    [copy.copyId, request.requestId, request.accessHash, uuid()],
  );
  assert.ok(reservation.rows[0].reservation_id);
  await approve(request.requestId, base.actor);
  const planned = await admin.query(
    "SELECT * FROM public.plan_exchange($1, $2, $3, $4)",
    [request.requestId, `REC-${runId}-${label}`, uuid(), base.actor.manager.id],
  );
  return {
    ...copy,
    ...request,
    exchangeId: Number(planned.rows[0].exchange_id),
    receptionId: Number(planned.rows[0].reception_id),
  };
}

async function receiveBook(base, flow) {
  const dropoffKey = uuid();
  const dropoff = await admin.query(
    "SELECT public.schedule_delivery($1, 'offered_book_dropoff', clock_timestamp(), $2, $3)",
    [flow.exchangeId, dropoffKey, base.actor.manager.id],
  );
  await admin.query(
    "SELECT public.confirm_delivery($1, $2, $3, 'dropoff', $4)",
    [Number(dropoff.rows[0].schedule_delivery), base.actor.receiver.id, `receipt/dropoff-${flow.exchangeId}`, dropoffKey],
  );
  await admin.query(
    "SELECT public.place_reception_in_custody($1, $2, 'Shelf P0', 'Custodian P0', $3, $4)",
    [flow.receptionId, base.actor.receiver.id, `custody/${flow.exchangeId}`, uuid()],
  );
}

async function acceptAndAdmit(base, flow) {
  await admin.query(
    "SELECT public.evaluate_reception($1, $2, 'accepted', 'good', 'accepted', $3, $4)",
    [flow.receptionId, base.actor.evaluator.id, uuid(), `transfer/${flow.exchangeId}`],
  );
  const cataloging = await admin.query(
    "SELECT public.prepare_cataloging($1, $2, $3, $4, $5, $6, $7)",
    [
      flow.receptionId,
      `Offered bib ${flow.exchangeId}`,
      `Offered author ${flow.exchangeId}`,
      null,
      null,
      base.actor.validator.id,
      uuid(),
    ],
  );
  await admin.query(
    "SELECT public.authorize_cataloging($1, $2, $3)",
    [Number(cataloging.rows[0].prepare_cataloging), base.actor.authorizer.id, uuid()],
  );
  const admission = await admin.query(
    "SELECT public.authorize_inventory_admission($1, $2, $3)",
    [flow.receptionId, base.actor.manager.id, uuid()],
  );
  const admissionId = Number(admission.rows[0].authorize_inventory_admission);
  const copy = await admin.query(
    "SELECT public.admit_received_book($1, $2, 'Shelf P0', $3)",
    [admissionId, `IUB-REC-${flow.exchangeId}`, base.actor.manager.id],
  );
  const offeredCopyId = Number(copy.rows[0].admit_received_book);
  await admin.query("SELECT public.enable_received_copy($1, $2)", [admissionId, base.actor.manager.id]);
  return { admissionId, offeredCopyId };
}

async function startAndHandover(base, flow) {
  await admin.query("SELECT public.start_exchange($1, $2)", [flow.exchangeId, base.actor.manager.id]);
  const handoverKey = uuid();
  const handover = await admin.query(
    "SELECT public.schedule_delivery($1, 'institutional_copy_handover', clock_timestamp() + interval '1 hour', $2, $3)",
    [flow.exchangeId, handoverKey, base.actor.manager.id],
  );
  await admin.query(
    "SELECT public.confirm_delivery($1, $2, $3, 'handover', $4)",
    [Number(handover.rows[0].schedule_delivery), base.actor.receiver.id, `receipt/handover-${flow.exchangeId}`, handoverKey],
  );
}

async function deliveryId(flow, type = "offered_book_return") {
  const result = await migrator.query(
    "SELECT id, idempotency_key FROM public.deliveries WHERE exchange_id = $1 AND delivery_type = $2 ORDER BY id DESC LIMIT 1",
    [flow.exchangeId, type],
  );
  return result.rows[0];
}

async function tests(base) {
  // 1. Cancellation before physical receipt.
  {
    const flow = await createReservedScenario(base, `cancel-before-${next()}`);
    const key = uuid();
    await admin.query("SELECT public.cancel_exchange($1, $2, $3, $4)", [flow.exchangeId, key, base.actor.manager.id, "cancel before receipt"]);
    const replay = await admin.query("SELECT public.cancel_exchange($1, $2, $3, $4)", [flow.exchangeId, key, base.actor.manager.id, "replay"]);
    assert.equal(Number(replay.rows[0].cancel_exchange), flow.exchangeId);
    const state = await migrator.query(
      `SELECT e.status AS exchange_status, r.status AS request_status, rec.status AS reception_status,
              c.availability, res.status AS reservation_status
       FROM public.exchanges e
       JOIN public.exchange_requests r ON r.id = e.request_id
       JOIN public.receptions rec ON rec.id = e.offered_reception_id
       JOIN public.copies c ON c.id = e.institutional_copy_id
       LEFT JOIN public.reservations res ON res.request_id = e.request_id AND res.copy_id = e.institutional_copy_id
       WHERE e.id = $1`,
      [flow.exchangeId],
    );
    assert.deepEqual(state.rows[0], {
      exchange_status: "cancelled",
      request_status: "cancelled",
      reception_status: "cancelled",
      availability: "available",
      reservation_status: "released",
    });
    console.log("ok - cancellation before physical receipt");
  }

  // 2. Cancellation after custody requires a confirmed physical return.
  {
    const flow = await createReservedScenario(base, `cancel-custody-${next()}`);
    await receiveBook(base, flow);
    const key = uuid();
    await admin.query("SELECT public.cancel_exchange($1, $2, $3, $4)", [flow.exchangeId, key, base.actor.manager.id, "return required"]);
    const pending = await migrator.query(
      `SELECT e.status AS exchange_status, r.status AS request_status, rec.status AS reception_status,
              c.availability, d.status AS return_status
       FROM public.exchanges e
       JOIN public.exchange_requests r ON r.id = e.request_id
       JOIN public.receptions rec ON rec.id = e.offered_reception_id
       JOIN public.copies c ON c.id = e.institutional_copy_id
       JOIN public.deliveries d ON d.exchange_id = e.id AND d.delivery_type = 'offered_book_return'
       WHERE e.id = $1`,
      [flow.exchangeId],
    );
    assert.equal(pending.rows[0].exchange_status, "cancellation_pending");
    assert.equal(pending.rows[0].request_status, "cancellation_pending");
    assert.equal(pending.rows[0].reception_status, "return_pending");
    assert.equal(pending.rows[0].availability, "reserved");
    assert.equal(pending.rows[0].return_status, "scheduled");

    await expectPostgresError(
      admin.query("SELECT public.cancel_exchange($1, $2, $3, $4)", [flow.exchangeId, key, base.actor.manager.id, "still pending"]),
      "55000",
    );
    await expectPostgresError(
      admin.query("SELECT public.evaluate_reception($1, $2, 'accepted', 'good', 'late', $3, 'late/evidence')",
        [flow.receptionId, base.actor.evaluator.id, uuid()]),
      "23514",
    );
    await expectPostgresError(
      admin.query("SELECT public.authorize_inventory_admission($1, $2, $3)",
        [flow.receptionId, base.actor.manager.id, uuid()]),
      "23514",
    );

    const returnDelivery = await deliveryId(flow);
    await admin.query(
      "SELECT public.confirm_delivery($1, $2, $3, 'returned', $4)",
      [returnDelivery.id, base.actor.receiver.id, `receipt/return-${flow.exchangeId}`, returnDelivery.idempotency_key],
    );
    await admin.query("SELECT public.cancel_exchange($1, $2, $3, $4)", [flow.exchangeId, key, base.actor.manager.id, "returned"]);
    const state = await migrator.query(
      `SELECT e.status AS exchange_status, r.status AS request_status, rec.status AS reception_status,
              c.availability, (SELECT count(*)::int FROM public.ownership_transfers t WHERE t.request_id = e.request_id) AS transfers,
              (SELECT count(*)::int FROM public.inventory_admissions a WHERE a.reception_id = e.offered_reception_id) AS admissions
       FROM public.exchanges e
       JOIN public.exchange_requests r ON r.id = e.request_id
       JOIN public.receptions rec ON rec.id = e.offered_reception_id
       JOIN public.copies c ON c.id = e.institutional_copy_id
       WHERE e.id = $1`,
      [flow.exchangeId],
    );
    assert.deepEqual(state.rows[0], {
      exchange_status: "cancelled",
      request_status: "cancelled",
      reception_status: "returned",
      availability: "available",
      transfers: 0,
      admissions: 0,
    });
    console.log("ok - cancellation after custody requires confirmed return and creates no admission");
  }

  // 3. Accepted book is not available before completion; cancellation compensates after return.
  {
    const flow = await createReservedScenario(base, `cancel-accepted-${next()}`);
    await receiveBook(base, flow);
    const offer = await acceptAndAdmit(base, flow);
    const before = await migrator.query(
      "SELECT availability FROM public.copies WHERE id = $1",
      [offer.offeredCopyId],
    );
    assert.equal(before.rows[0].availability, "unavailable");

    const key = uuid();
    await admin.query("SELECT public.cancel_exchange($1, $2, $3, $4)", [flow.exchangeId, key, base.actor.manager.id, "accepted return"]);
    const returnDelivery = await deliveryId(flow);
    await admin.query(
      "SELECT public.confirm_delivery($1, $2, $3, 'returned', $4)",
      [returnDelivery.id, base.actor.receiver.id, `receipt/return-${flow.exchangeId}`, returnDelivery.idempotency_key],
    );
    await admin.query("SELECT public.cancel_exchange($1, $2, $3, $4)", [flow.exchangeId, key, base.actor.manager.id, "accepted returned"]);

    const state = await migrator.query(
      `SELECT e.status AS exchange_status, r.status AS request_status, rec.status AS reception_status,
              a.status AS admission_status, c.availability AS offered_availability,
              (SELECT count(*)::int FROM public.ownership_transfer_reversals rev
               JOIN public.ownership_transfers t ON t.id = rev.transfer_id
               WHERE t.request_id = e.request_id) AS reversals,
              (SELECT count(*)::int FROM public.ownership_transfers t WHERE t.request_id = e.request_id) AS transfers
       FROM public.exchanges e
       JOIN public.exchange_requests r ON r.id = e.request_id
       JOIN public.receptions rec ON rec.id = e.offered_reception_id
       JOIN public.inventory_admissions a ON a.reception_id = e.offered_reception_id
       JOIN public.copies c ON c.id = a.copy_id
       WHERE e.id = $1`,
      [flow.exchangeId],
    );
    assert.equal(state.rows[0].exchange_status, "cancelled");
    assert.equal(state.rows[0].request_status, "cancelled");
    assert.equal(state.rows[0].reception_status, "returned");
    assert.equal(state.rows[0].admission_status, "reversed");
    assert.equal(state.rows[0].offered_availability, "retired");
    assert.equal(state.rows[0].reversals, 1);
    assert.equal(state.rows[0].transfers, 1);
    console.log("ok - accepted cancellation requires return, reverses transfer and retires offered copy");
  }

  // 4. Two concurrent reservations never create two active holds.
  {
    const copy = await createInstitutionalCopy(base, `double-${next()}`);
    const first = await createRequest(copy.copyId, `double-a-${next()}`);
    const second = await createRequest(copy.copyId, `double-b-${next()}`);
    await approve(first.requestId, base.actor);
    await approve(second.requestId, base.actor);
    const results = await Promise.allSettled([
      publicRuntime.query("SELECT * FROM public.reserve_copy($1, $2, $3, $4)", [copy.copyId, first.requestId, first.accessHash, uuid()]),
      publicTwo.query("SELECT * FROM public.reserve_copy($1, $2, $3, $4)", [copy.copyId, second.requestId, second.accessHash, uuid()]),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const active = await migrator.query(
      "SELECT count(*)::int AS count FROM public.reservations WHERE copy_id = $1 AND status = 'active'",
      [copy.copyId],
    );
    assert.equal(active.rows[0].count, 1);
    console.log("ok - concurrent reservations serialize to one active hold");
  }

  // 5. Expiry and a new reservation cannot leave two holds or an inconsistent copy.
  {
    const copy = await createInstitutionalCopy(base, `expire-${next()}`);
    const first = await createRequest(copy.copyId, `expire-a-${next()}`);
    const second = await createRequest(copy.copyId, `expire-b-${next()}`);
    await approve(first.requestId, base.actor);
    await approve(second.requestId, base.actor);
    await admin.query("SELECT public.set_reservation_policy(1, $1)", [base.actor.manager.id]);
    await publicRuntime.query("SELECT * FROM public.reserve_copy($1, $2, $3, $4)", [copy.copyId, first.requestId, first.accessHash, uuid()]);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const results = await Promise.allSettled([
      admin.query("SELECT public.expire_reservations($1, 100)", [base.actor.manager.id]),
      publicTwo.query("SELECT * FROM public.reserve_copy($1, $2, $3, $4)", [copy.copyId, second.requestId, second.accessHash, uuid()]),
    ]);
    assert.ok(results[0].status === "fulfilled");
    const active = await migrator.query(
      "SELECT count(*)::int AS count FROM public.reservations WHERE copy_id = $1 AND status = 'active'",
      [copy.copyId],
    );
    assert.ok(active.rows[0].count <= 1);
    if (results[1].status === "rejected") {
      await admin.query("SELECT public.expire_reservations($1, 100)", [base.actor.manager.id]);
      await publicTwo.query("SELECT * FROM public.reserve_copy($1, $2, $3, $4)", [copy.copyId, second.requestId, second.accessHash, uuid()]);
    }
    const final = await migrator.query(
      `SELECT c.availability, count(*) FILTER (WHERE r.status = 'active')::int AS active
       FROM public.copies c LEFT JOIN public.reservations r ON r.copy_id = c.id
       WHERE c.id = $1 GROUP BY c.availability`,
      [copy.copyId],
    );
    assert.equal(final.rows[0].active, 1);
    assert.equal(final.rows[0].availability, "reserved");
    await admin.query("SELECT public.set_reservation_policy(3600, $1)", [base.actor.manager.id]);
    console.log("ok - expiry and reservation keep one active hold");
  }

  // 6. Cancel vs reserve race: a cancelled request never keeps an active hold.
  {
    const flow = await createReservedScenario(base, `cancel-race-${next()}`);
    const results = await Promise.allSettled([
      admin.query("SELECT public.cancel_exchange($1, $2, $3, $4)", [flow.exchangeId, uuid(), base.actor.manager.id, "race"]),
      publicRuntime.query("SELECT * FROM public.reserve_copy($1, $2, $3, $4)", [flow.copyId, flow.requestId, flow.accessHash, uuid()]),
    ]);
    assert.ok(results[0].status === "fulfilled");
    const state = await migrator.query(
      `SELECT e.status, count(r.id) FILTER (WHERE r.status = 'active')::int AS active
       FROM public.exchanges e
       LEFT JOIN public.reservations r ON r.request_id = e.request_id AND r.copy_id = e.institutional_copy_id
       WHERE e.id = $1 GROUP BY e.status`,
      [flow.exchangeId],
    );
    assert.equal(state.rows[0].status, "cancelled");
    assert.equal(state.rows[0].active, 0);
    console.log("ok - cancel/reserve race leaves no active hold");
  }

  // 7. Confirmed institutional handover blocks cancellation.
  {
    const flow = await createReservedScenario(base, `handover-${next()}`);
    await receiveBook(base, flow);
    await acceptAndAdmit(base, flow);
    await startAndHandover(base, flow);
    await expectPostgresError(
      admin.query("SELECT public.cancel_exchange($1, $2, $3, $4)", [flow.exchangeId, uuid(), base.actor.manager.id, "too late"]),
      "23514",
    );
    const state = await migrator.query("SELECT status FROM public.exchanges WHERE id = $1", [flow.exchangeId]);
    assert.equal(state.rows[0].status, "in_process");
    console.log("ok - confirmed institutional handover blocks cancellation");
  }

  // 8. Completion makes the offered copy available only at the valid close.
  {
    const flow = await createReservedScenario(base, `complete-${next()}`);
    await receiveBook(base, flow);
    const offer = await acceptAndAdmit(base, flow);
    const watcher = await createRequest(offer.offeredCopyId, `watcher-${next()}`);
    await expectPostgresError(approve(watcher.requestId, base.actor), "23514");
    await expectPostgresError(
      publicRuntime.query("SELECT * FROM public.reserve_copy($1, $2, $3, $4)",
        [offer.offeredCopyId, watcher.requestId, watcher.accessHash, uuid()]),
      "23514",
    );

    await startAndHandover(base, flow);
    const completionKey = uuid();
    await admin.query("SELECT public.complete_exchange($1, $2, $3)", [flow.exchangeId, completionKey, base.actor.manager.id]);
    const completionReplay = await admin.query(
      "SELECT public.complete_exchange($1, $2, $3)",
      [flow.exchangeId, completionKey, base.actor.manager.id],
    );
    assert.equal(Number(completionReplay.rows[0].complete_exchange), flow.exchangeId);
    const state = await migrator.query(
      `SELECT e.status AS exchange_status, r.status AS request_status,
              ic.availability AS institutional_availability, oc.availability AS offered_availability
       FROM public.exchanges e
       JOIN public.exchange_requests r ON r.id = e.request_id
       JOIN public.copies ic ON ic.id = e.institutional_copy_id
       JOIN public.copies oc ON oc.id = $2
       WHERE e.id = $1`,
      [flow.exchangeId, offer.offeredCopyId],
    );
    assert.deepEqual(state.rows[0], {
      exchange_status: "completed",
      request_status: "completed",
      institutional_availability: "retired",
      offered_availability: "available",
    });
    await expectPostgresError(
      migrator.query("UPDATE public.copies SET availability = 'available' WHERE id = $1", [offer.offeredCopyId]),
      "42501",
    );
    const watcherReservation = await publicRuntime.query(
      "SELECT * FROM public.reserve_copy($1, $2, $3, $4)",
      [offer.offeredCopyId, watcher.requestId, watcher.accessHash, uuid()],
    );
    assert.ok(watcherReservation.rows[0].reservation_id);
    await expectPostgresError(
      admin.query("SELECT public.cancel_exchange($1, $2, $3, $4)", [flow.exchangeId, uuid(), base.actor.manager.id, "completed"]),
      "23514",
    );
    console.log("ok - completion releases offered copy only at the valid close");
  }

  // 9. Two cancellations serialize without deadlock and with idempotency keys.
  {
    const flow = await createReservedScenario(base, `deadlock-${next()}`);
    const firstKey = uuid();
    const secondKey = uuid();
    const results = await Promise.allSettled([
      admin.query("SELECT public.cancel_exchange($1, $2, $3, $4)", [flow.exchangeId, firstKey, base.actor.manager.id, "first"]),
      adminTwo.query("SELECT public.cancel_exchange($1, $2, $3, $4)", [flow.exchangeId, secondKey, base.actor.manager.id, "second"]),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected);
    assert.notEqual(rejected.reason.code, "40P01");
    assert.equal(rejected.reason.code, "23505");
    console.log("ok - concurrent cancellations serialize without deadlock");
  }

  // 11. Rejected reception follows the existing return flow without admissions.
  {
    const flow = await createReservedScenario(base, `rejected-${next()}`);
    await receiveBook(base, flow);
    await admin.query(
      "SELECT public.evaluate_reception($1, $2, 'rejected', 'poor', 'rejected condition', $3, $4)",
      [flow.receptionId, base.actor.evaluator.id, uuid(), `rejection/${flow.exchangeId}`],
    );
    const rejected = await migrator.query(
      `SELECT e.status AS exchange_status, r.status AS request_status, rec.status AS reception_status,
              c.availability, res.status AS reservation_status
       FROM public.exchanges e
       JOIN public.exchange_requests r ON r.id = e.request_id
       JOIN public.receptions rec ON rec.id = e.offered_reception_id
       JOIN public.copies c ON c.id = e.institutional_copy_id
       LEFT JOIN public.reservations res ON res.request_id = e.request_id AND res.copy_id = e.institutional_copy_id
       WHERE e.id = $1`,
      [flow.exchangeId],
    );
    assert.deepEqual(rejected.rows[0], {
      exchange_status: "cancelled",
      request_status: "rejected",
      reception_status: "rejected",
      availability: "available",
      reservation_status: "released",
    });
    await admin.query("SELECT public.request_reception_return($1, $2, 'return rejected book')", [flow.receptionId, base.actor.manager.id]);
    const returnKey = uuid();
    const returnDelivery = await admin.query(
      "SELECT public.schedule_delivery($1, 'offered_book_return', clock_timestamp() + interval '1 hour', $2, $3)",
      [flow.exchangeId, returnKey, base.actor.manager.id],
    );
    await admin.query(
      "SELECT public.confirm_delivery($1, $2, $3, 'returned', $4)",
      [Number(returnDelivery.rows[0].schedule_delivery), base.actor.receiver.id, `receipt/reject-return-${flow.exchangeId}`, returnKey],
    );
    const returned = await migrator.query("SELECT status FROM public.receptions WHERE id = $1", [flow.receptionId]);
    assert.equal(returned.rows[0].status, "returned");
    console.log("ok - rejected reception returns physically without admission");
  }

  // 10. An independent session blocks on the copy lock instead of bypassing it.
  {
    const copy = await createInstitutionalCopy(base, `blocking-${next()}`);
    const first = await createRequest(copy.copyId, `blocking-a-${next()}`);
    const second = await createRequest(copy.copyId, `blocking-b-${next()}`);
    await approve(first.requestId, base.actor);
    await approve(second.requestId, base.actor);

    await blocker.query("BEGIN");
    try {
      await blocker.query("SELECT * FROM public.reserve_copy($1, $2, $3, $4)",
        [copy.copyId, first.requestId, first.accessHash, uuid()]);
      const waiting = publicRuntime.query("SELECT * FROM public.reserve_copy($1, $2, $3, $4)",
        [copy.copyId, second.requestId, second.accessHash, uuid()]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const locks = await migrator.query(
        "SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted",
      );
      assert.ok(locks.rows[0].waiting > 0, "the second session must wait on a PostgreSQL lock");
      await blocker.query("COMMIT");
      await expectPostgresError(waiting, "23514");
    } catch (error) {
      await blocker.query("ROLLBACK").catch(() => undefined);
      throw error;
    }

    const active = await migrator.query(
      "SELECT count(*)::int AS count FROM public.reservations WHERE copy_id = $1 AND status = 'active'",
      [copy.copyId],
    );
    assert.equal(active.rows[0].count, 1);
    console.log("ok - independent session blocks on the copy lock");
  }

  // 11. Participant intake is atomic and idempotent.
  {
    const functionExists = await migrator.query(
      "SELECT to_regprocedure('public.create_exchange_request(text,jsonb,uuid)') IS NOT NULL AS present",
    );
    if (functionExists.rows[0]?.present) {
      const copy = await createInstitutionalCopy(base, `intake-${next()}`);
      const suffix = next();
      const fingerprint = digest(`intake-fingerprint-${suffix}`);
      const accessHash = digest(`intake-access-${suffix}`);
      const payload = {
        participant: {
          fullNameCiphertext: digest(`intake-name-${suffix}`).toString("hex"),
          fullNameKeyVersion: 1,
          emailCiphertext: digest(`intake-email-${suffix}`).toString("hex"),
          emailKeyVersion: 1,
          identityCiphertext: digest(`intake-identity-${suffix}`).toString("hex"),
          identityKeyVersion: 1,
          identityFingerprint: fingerprint.toString("hex"),
          hmacKeyVersion: 1,
        },
        consent: {
          noticeVersion: "notice-2026-01",
          evidenceSha256: digest(`intake-consent-${suffix}`).toString("hex"),
        },
        request: { requestedCopyId: String(copy.copyId), accessTokenSha256: accessHash.toString("hex") },
        offeredBook: {
          title: `Offered intake ${suffix}`,
          author: "Intake author",
          declaredCondition: "good",
          isbn: null,
          isbnNormalized: null,
        },
      };
      const key = uuid();
      const first = await publicRuntime.query(
        "SELECT * FROM public.create_exchange_request($1, $2::jsonb, $3)",
        [`INTAKE-${runId}-${suffix}`, JSON.stringify(payload), key],
      );
      const second = await publicRuntime.query(
        "SELECT * FROM public.create_exchange_request($1, $2::jsonb, $3)",
        [`INTAKE-${runId}-${suffix}`, JSON.stringify(payload), key],
      );
      assert.equal(first.rows[0].request_id, second.rows[0].request_id);
      const status = await publicRuntime.query(
        "SELECT status FROM public.get_request_status($1, $2)",
        [`INTAKE-${runId}-${suffix}`, accessHash],
      );
      assert.equal(status.rows[0].status, "pending");
      console.log("ok - participant intake is atomic and idempotent");
    }
  }

  // 12. Effective permissions: runtime cannot bypass reviewed routines.
  {
    const privileges = await admin.query(
      `SELECT
         has_table_privilege('iub_admin_runtime', 'public.copies', 'UPDATE') AS admin_update,
         has_table_privilege('iub_public_runtime', 'public.copies', 'SELECT') AS public_reads_copies,
         has_function_privilege('iub_admin_runtime', 'public.iub_lock_request(bigint)', 'EXECUTE') AS admin_locks,
         has_function_privilege('iub_public_runtime', 'public.complete_exchange(bigint,uuid,bigint)', 'EXECUTE') AS public_completes,
         has_table_privilege('iub_admin_runtime', 'public.ownership_transfer_reversals', 'SELECT') AS admin_reads_reversals`,
    );
    assert.deepEqual(privileges.rows[0], {
      admin_update: false,
      public_reads_copies: false,
      admin_locks: false,
      public_completes: false,
      admin_reads_reversals: true,
    });
    await expectPostgresError(
      admin.query("UPDATE public.copies SET availability = 'available' WHERE id = 1"),
      "42501",
    );
    await expectPostgresError(
      admin.query("SELECT * FROM public.iub_lock_request(1)"),
      "42501",
    );
    console.log("ok - runtime permissions remain least-privilege");
  }

  // 13. Photographic review serializes concurrent reviewers and does not touch inventory.
  {
    const reviewer = await createActor(`photo-${next()}`, ["offered_books.review"]);
    const copy = await createInstitutionalCopy(base, `photo-${next()}`);
    const tokenHash = digest(`photo-token-${runId}-${next()}`);
    const submission = await migrator.query(
      `SELECT * FROM public.create_offered_book_submission(
        $1, $2, $3, $4, 'Editorial', 'Genero', NULL, NULL, 'good', 'obs', $5
      )`,
      [copy.copyId, tokenHash, `Libro foto ${runId}`, "Autora foto", uuid()],
    );
    const submissionId = Number(submission.rows[0].submission_id);
    for (const slot of ["cover", "interior"]) {
      await migrator.query(
        `SELECT * FROM public.register_offered_book_evidence(
          $1, $2, $3, $4, 'image/jpeg', 100, $5, 10, 10, $6
        )`,
        [submissionId, tokenHash, slot, `${runId}-${slot}.jpg`, digest(`${runId}-${slot}`), uuid()],
      );
    }
    const payload = {
      participant: {
        fullNameCiphertext: digest(`${runId}-name`).toString("hex"),
        fullNameKeyVersion: 1,
        emailCiphertext: digest(`${runId}-email`).toString("hex"),
        emailKeyVersion: 1,
        identityCiphertext: digest(`${runId}-identity`).toString("hex"),
        identityKeyVersion: 1,
        identityFingerprint: digest(`${runId}-fingerprint`).toString("hex"),
        hmacKeyVersion: 1,
      },
      consent: {
        noticeVersion: "notice-2026-01",
        evidenceSha256: digest(`${runId}-consent`).toString("hex"),
      },
      request: {
        requestedCopyId: copy.copyId,
        accessTokenSha256: digest(`${runId}-access`).toString("hex"),
      },
      offeredBook: {
        title: `Libro foto ${runId}`,
        author: "Autora foto",
        publisherClaim: "Editorial",
        genreClaim: "Genero",
        isbn: null,
        isbnNormalized: null,
        declaredCondition: "good",
        observations: "obs",
      },
    };
    await migrator.query(
      `SELECT * FROM public.submit_offered_book_submission($1, $2, $3, $4::jsonb, $5)`,
      [submissionId, tokenHash, `PHOTO-REQUEST-${runId}-${next()}`, JSON.stringify(payload), uuid()],
    );

    const reviews = await Promise.allSettled([
      admin.query(
        "SELECT * FROM public.review_offered_book_submission($1, $2, 'start_review', 'inicio', NULL, $3)",
        [submissionId, reviewer.id, uuid()],
      ),
      adminTwo.query(
        "SELECT * FROM public.review_offered_book_submission($1, $2, 'start_review', 'inicio', NULL, $3)",
        [submissionId, reviewer.id, uuid()],
      ),
    ]);
    assert.equal(reviews.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = reviews.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.equal(rejected.reason.code, "23514");
    const state = await migrator.query(
      `SELECT s.status,
        (SELECT count(*)::int FROM public.offered_book_submission_reviews r WHERE r.submission_id = s.id) AS reviews,
        (SELECT availability FROM public.copies c WHERE c.id = s.requested_copy_id) AS availability
       FROM public.offered_book_submissions s WHERE s.id = $1`,
      [submissionId],
    );
    assert.deepEqual(state.rows[0], { status: "in_review", reviews: 1, availability: "available" });
    console.log("ok - photographic review serializes reviewers without touching inventory");
  }

  // 13. P0 containment: verified institutional copies work; unverified copies
  // cannot be published, requested or reserved, even with concurrent clients.
  {
    const bib = await migrator.query(
      `INSERT INTO public.bibliographic_records (title, author, publisher_id, genre_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`Containment verified ${runId}`, "Author", base.publisherId, base.genreId],
    );
    const verified = await migrator.query(
      `INSERT INTO public.copies
         (bibliographic_record_id, inventory_code, physical_condition, availability,
          provenance_type, verified_at, verified_by, verification_reference)
       VALUES ($1, $2, 'good', 'unavailable', 'institutional', clock_timestamp(), $3, $4)
       RETURNING id`,
      [Number(bib.rows[0].id), `IUB-CONTAIN-${runId}-OK`, base.actor.manager.id, `containment-${runId}`],
    );
    const verifiedId = Number(verified.rows[0].id);
    await migrator.query("UPDATE public.copies SET availability = 'available' WHERE id = $1", [verifiedId]);

    const visible = await publicRuntime.query(
      "SELECT count(*)::int AS count FROM public.available_catalog WHERE copy_id = $1",
      [verifiedId],
    );
    assert.equal(visible.rows[0].count, 1);

    const requestOne = await createRequest(verifiedId, "containment-1");
    const requestTwo = await createRequest(verifiedId, "containment-2");

    const outcomes = await Promise.allSettled([
      publicRuntime.query("SELECT * FROM public.reserve_copy($1, $2, $3, $4)", [
        verifiedId, requestOne.requestId, requestOne.accessHash, uuid(),
      ]),
      publicTwo.query("SELECT * FROM public.reserve_copy($1, $2, $3, $4)", [
        verifiedId, requestTwo.requestId, requestTwo.accessHash, uuid(),
      ]),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.equal(rejected.reason.code, "23514");

    const state = await migrator.query(
      `SELECT c.availability,
         (SELECT count(*)::int FROM public.reservations r WHERE r.copy_id = c.id AND r.status = 'active') AS reservations,
         (SELECT count(*)::int FROM public.inventory_movements m WHERE m.copy_id = c.id) AS movements
       FROM public.copies c WHERE c.id = $1`,
      [verifiedId],
    );
    assert.deepEqual(state.rows[0], { availability: "reserved", reservations: 1, movements: 1 });

    const catalog = await publicRuntime.query(
      "SELECT count(*)::int AS count FROM public.available_catalog WHERE copy_id = $1",
      [verifiedId],
    );
    assert.equal(catalog.rows[0].count, 0);

    const bib2 = await migrator.query(
      `INSERT INTO public.bibliographic_records (title, author, publisher_id, genre_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`Containment unverified ${runId}`, "Author", base.publisherId, base.genreId],
    );
    const unverified = await migrator.query(
      `INSERT INTO public.copies
         (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
       VALUES ($1, $2, 'unassessed', 'unavailable', 'institutional') RETURNING id`,
      [Number(bib2.rows[0].id), `IUB-CONTAIN-${runId}-NO`],
    );
    const unverifiedId = Number(unverified.rows[0].id);

    await expectPostgresError(
      migrator.query("UPDATE public.copies SET availability = 'available' WHERE id = $1", [unverifiedId]),
      "42501",
    );
    const hidden = await publicRuntime.query(
      "SELECT count(*)::int AS count FROM public.available_catalog WHERE copy_id = $1",
      [unverifiedId],
    );
    assert.equal(hidden.rows[0].count, 0);

    await migrator.query("BEGIN");
    await expectPostgresError(
      createRequest(unverifiedId, "containment-unverified"),
      "23514",
    );
    await migrator.query("ROLLBACK");

    console.log("ok - institutional containment gates catalogue, requests and concurrent reservations");
  }
}

try {
  await connectAll();
  await tests(await seedBase());
  console.log("all PostgreSQL P0 tests passed");
} finally {
  await closeAll();
}
