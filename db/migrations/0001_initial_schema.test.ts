// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migrationUrl = new URL("./0001_initial_schema.sql", import.meta.url);
const correctiveUrl = new URL("./0002_corrective_schema.sql", import.meta.url);
const privilegesUrl = new URL("./0003_runtime_privileges.sql", import.meta.url);
const digest = (byte: number) => Buffer.alloc(32, byte);

type Actor = { id: number; roleId: number };
type Workflow = {
  actor: Record<string, Actor>;
  copyId: number;
  requestId: number;
  requestAccessHash: Buffer;
  exchangeId: number;
  receptionId: number;
  admissionId?: number;
  offeredCopyId?: number;
  evaluationId?: number;
  catalogingId?: number;
  deliveryDropoffId: number;
};

describe("corrected PostgreSQL baseline and business invariants", () => {
  let database: PGlite;
  let roleSequence = 0;

  beforeEach(async () => {
    database = new PGlite();
    roleSequence = 0;
    const migration = await readFile(migrationUrl, "utf8");
    const corrective = await readFile(correctiveUrl, "utf8");
    const privileges = await readFile(privilegesUrl, "utf8");

    await database.exec(`
      CREATE ROLE iub_schema_migrator LOGIN;
      CREATE ROLE iub_public_runtime LOGIN;
      CREATE ROLE iub_admin_runtime LOGIN;
      GRANT USAGE, CREATE ON SCHEMA public TO iub_schema_migrator;
      SET ROLE iub_schema_migrator;
    `);
    await database.exec("BEGIN");
    await database.exec(migration);
    await database.exec(corrective);
    await database.exec(privileges);
    await database.exec("COMMIT");
    await database.exec("RESET ROLE");
  });

  afterEach(async () => {
    await database.close();
  });

  async function createActor(name: string, permissionKeys: string[]): Promise<Actor> {
    const user = await database.query<{ id: string }>(
      `INSERT INTO public.app_users (identity_issuer, identity_subject)
       VALUES ('https://issuer.test', $1) RETURNING id`,
      [name],
    );
    const roleKey = `test_role_${roleSequence++}`;
    const role = await database.query<{ id: string }>(
      `INSERT INTO public.roles (role_key, display_name) VALUES ($1, $1) RETURNING id`,
      [roleKey],
    );
    const userId = Number(user.rows[0]!.id);
    const roleId = Number(role.rows[0]!.id);

    await database.query(
      "INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)",
      [userId, roleId],
    );
    for (const permissionKey of permissionKeys) {
      await database.query(
        `INSERT INTO public.role_permissions (role_id, permission_id)
         SELECT $1, id FROM public.permissions WHERE permission_key = $2`,
        [roleId, permissionKey],
      );
    }
    return { id: userId, roleId };
  }

  async function createParticipantAndRequest(
    name: string,
    copyId: number,
    requestSuffix: string,
  ): Promise<{ participantId: number; requestId: number; consentId: number; accessHash: Buffer }> {
    const noticeVersion = "notice-2026-01";
    await database.query(
      `INSERT INTO public.privacy_notices (version, content_sha256, approved_at)
       VALUES ($1, $2, clock_timestamp()) ON CONFLICT (version) DO NOTHING`,
      [noticeVersion, digest(80)],
    );
    const participant = await database.query<{ id: string }>(
      `INSERT INTO public.participants
        (full_name_ciphertext, full_name_key_version, email_ciphertext, email_key_version,
         identity_ciphertext, identity_key_version)
       VALUES ($1, 1, $2, 1, $3, 1) RETURNING id`,
      [Buffer.from(`name-${name}`), Buffer.from(`email-${name}`), Buffer.from(`id-${name}`)],
    );
    const participantId = Number(participant.rows[0]!.id);
    const accessHash = digest(20 + Number(requestSuffix.replace(/\D/g, "")));
    await database.query(
      `INSERT INTO public.participant_document_fingerprints
        (participant_id, hmac_key_version, fingerprint) VALUES ($1, 1, $2)`,
      [participantId, digest(30 + Number(requestSuffix.replace(/\D/g, "")))],
    );
    const consent = await database.query<{ id: string }>(
      `INSERT INTO public.privacy_consents
        (participant_id, notice_version, purpose, consented_at, evidence_sha256, capture_channel, idempotency_key)
       VALUES ($1, $2, 'book_exchange', clock_timestamp(), $3, 'web', $4) RETURNING id`,
      [participantId, noticeVersion, digest(90), `11000000-0000-4000-8000-${requestSuffix.padStart(12, "0")}`],
    );
    const request = await database.query<{ id: string }>(
      `INSERT INTO public.exchange_requests
        (request_code, participant_id, requested_copy_id, privacy_consent_id,
         request_access_token_sha256, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [`REQUEST-${requestSuffix}`, participantId, copyId, Number(consent.rows[0]!.id), accessHash, `00000000-0000-4000-8000-${requestSuffix.padStart(12, "0")}`],
    );
    const requestId = Number(request.rows[0]!.id);
    await database.query(
      `INSERT INTO public.offered_books
        (request_id, title, author, declared_condition)
       VALUES ($1, $2, $3, 'good')`,
      [requestId, `Offered title ${requestSuffix}`, `Offered author ${requestSuffix}`],
    );
    return { participantId, requestId, consentId: Number(consent.rows[0]!.id), accessHash };
  }

  async function createInstitutionalCopy(code = "IUB-001"): Promise<{ copyId: number; bibId: number }> {
    const publisher = await database.query<{ id: string }>(
      `INSERT INTO public.publishers (name, normalized_name) VALUES ('Editorial Test', 'editorial-test') RETURNING id`,
    );
    const genre = await database.query<{ id: string }>(
      `INSERT INTO public.genres (name, normalized_name) VALUES ('Literatura', 'literatura') RETURNING id`,
    );
    const bib = await database.query<{ id: string }>(
      `INSERT INTO public.bibliographic_records (title, author, publisher_id, genre_id)
       VALUES ('Institutional title', 'Institutional author', $1, $2) RETURNING id`,
      [Number(publisher.rows[0]!.id), Number(genre.rows[0]!.id)],
    );
    const copy = await database.query<{ id: string }>(
      `INSERT INTO public.copies
        (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
       VALUES ($1, $2, 'good', 'available', 'preexisting') RETURNING id`,
      [Number(bib.rows[0]!.id), code],
    );
    return { copyId: Number(copy.rows[0]!.id), bibId: Number(bib.rows[0]!.id) };
  }

  async function runToReceptionInCustody(): Promise<Workflow> {
    const actor = {
      manager: await createActor("manager", [
        "requests.review", "reservations.configure", "reservations.expire", "exchange.plan", "delivery.schedule",
        "delivery.confirm", "exchange.start", "exchange.complete", "exchange.cancel", "inventory.admit",
        "inventory.enable", "reception.return",
      ]),
      receiver: await createActor("receiver", ["delivery.confirm", "custody.transfer"]),
      evaluator: await createActor("evaluator", ["reception.evaluate"]),
      validator: await createActor("validator", ["cataloging.validate"]),
      authorizer: await createActor("authorizer", ["cataloging.authorize"]),
    };
    await database.query(
      "SELECT public.set_reservation_policy(3600, $1)",
      [actor.manager.id],
    );
    const { copyId } = await createInstitutionalCopy();
    const participant = await createParticipantAndRequest("participant-1", copyId, "1");

    const firstReservation = await database.query<{ reservation_id: string }>(
      "SELECT public.reserve_copy($1, $2, $3, $4)",
      [copyId, participant.requestId, participant.accessHash, "10000000-0000-4000-8000-000000000001"],
    );
    const reservationReplay = await database.query<{ reservation_id: string }>(
      "SELECT public.reserve_copy($1, $2, $3, $4)",
      [copyId, participant.requestId, participant.accessHash, "10000000-0000-4000-8000-000000000001"],
    );
    expect(reservationReplay.rows[0]?.reservation_id).toBe(firstReservation.rows[0]?.reservation_id);
    await database.query("SELECT public.set_request_status($1, 'under_review', $2, 'review')", [participant.requestId, actor.manager.id]);
    await database.query("SELECT public.set_request_status($1, 'approved', $2, 'approved')", [participant.requestId, actor.manager.id]);
    const planned = await database.query<{ exchange_id: string; reception_id: string }>(
      "SELECT * FROM public.plan_exchange($1, $2, $3, $4)",
      [participant.requestId, "REC-001", "20000000-0000-4000-8000-000000000001", actor.manager.id],
    );
    const exchangeId = Number(planned.rows[0]!.exchange_id);
    const receptionId = Number(planned.rows[0]!.reception_id);
    const deliveryDropoffId = Number((await database.query<{ schedule_delivery: string }>(
      "SELECT public.schedule_delivery($1, 'offered_book_dropoff', clock_timestamp() + interval '1 hour', $2, $3)",
      [exchangeId, "30000000-0000-4000-8000-000000000001", actor.manager.id],
    )).rows[0]!.schedule_delivery);

    await database.query(
      "SELECT public.confirm_delivery($1, $2, 'receipt/dropoff-1', 'Receiving', $3)",
      [deliveryDropoffId, actor.receiver.id, "30000000-0000-4000-8000-000000000001"],
    );
    await database.query(
      "SELECT public.place_reception_in_custody($1, $2, 'Shelf A', 'Custodian A', 'custody/ref-1', $3)",
      [receptionId, actor.receiver.id, "40000000-0000-4000-8000-000000000001"],
    );

    return {
      actor,
      copyId,
      requestId: participant.requestId,
      requestAccessHash: participant.accessHash,
      exchangeId,
      receptionId,
      deliveryDropoffId,
    };
  }

  async function admitOffer(workflow: Workflow): Promise<void> {
    const evaluated = await database.query<{ evaluate_reception: string }>(
      `SELECT public.evaluate_reception($1, $2, 'accepted', 'good', 'accepted condition', $3, 'property-transfer/ref-1')`,
      [workflow.receptionId, workflow.actor.evaluator.id, "50000000-0000-4000-8000-000000000001"],
    );
    workflow.evaluationId = Number(evaluated.rows[0]!.evaluate_reception);

    const offeredBib = await database.query<{ id: string }>(
      `INSERT INTO public.bibliographic_records (title, author)
       VALUES ('Offered title 1', 'Offered author 1') RETURNING id`,
    );
    const cataloging = await database.query<{ record_cataloging_validation: string }>(
      "SELECT public.record_cataloging_validation($1, $2, $3, $4)",
      [workflow.receptionId, Number(offeredBib.rows[0]!.id), workflow.actor.validator.id, "60000000-0000-4000-8000-000000000001"],
    );
    workflow.catalogingId = Number(cataloging.rows[0]!.record_cataloging_validation);
    await database.query(
      "SELECT public.authorize_cataloging($1, $2, $3)",
      [workflow.catalogingId, workflow.actor.authorizer.id, "70000000-0000-4000-8000-000000000001"],
    );
    const admission = await database.query<{ authorize_inventory_admission: string }>(
      "SELECT public.authorize_inventory_admission($1, $2, $3)",
      [workflow.receptionId, workflow.actor.manager.id, "80000000-0000-4000-8000-000000000001"],
    );
    workflow.admissionId = Number(admission.rows[0]!.authorize_inventory_admission);
    const copy = await database.query<{ admit_received_book: string }>(
      "SELECT public.admit_received_book($1, 'IUB-REC-001', 'Shelf B', $2)",
      [workflow.admissionId, workflow.actor.manager.id],
    );
    workflow.offeredCopyId = Number(copy.rows[0]!.admit_received_book);
  }

  it("applies the schema and installs transactional routines", async () => {
    const result = await database.query<{ relation_count: number }>(
      "SELECT count(*)::int AS relation_count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'",
    );
    expect(result.rows[0]?.relation_count).toBeGreaterThan(25);
    const routine = await database.query<{ exists: boolean }>(
      "SELECT to_regprocedure('public.complete_exchange(bigint,uuid,bigint)') IS NOT NULL AS exists",
    );
    expect(routine.rows[0]?.exists).toBe(true);
  });

  it("rolls back the baseline DDL as a unit when a statement fails", async () => {
    const rollbackDatabase = new PGlite();
    const migration = await readFile(migrationUrl, "utf8");
    const corrective = await readFile(correctiveUrl, "utf8");
    const privileges = await readFile(privilegesUrl, "utf8");
    await rollbackDatabase.exec(`
      CREATE ROLE iub_schema_migrator LOGIN;
      CREATE ROLE iub_public_runtime LOGIN;
      CREATE ROLE iub_admin_runtime LOGIN;
    `);
    await rollbackDatabase.exec("BEGIN");
    await expect(
      rollbackDatabase.exec(`${migration}\n${corrective}\n${privileges}\nSELECT * FROM public.table_that_does_not_exist;`),
    ).rejects.toThrow();
    await rollbackDatabase.exec("ROLLBACK");
    const relation = await rollbackDatabase.query<{ relation: string | null }>(
      "SELECT to_regclass('public.exchange_requests')::text AS relation",
    );
    expect(relation.rows[0]?.relation).toBeNull();
    await rollbackDatabase.close();
  });

  it("gives runtime roles no direct write or DDL and keeps history read-only", async () => {
    const privileges = await database.query<{
      public_insert: boolean;
      admin_update_history: boolean;
      public_schema_create: boolean;
      reserve_execute: boolean;
      complete_execute: boolean;
      public_group_write: boolean;
      public_group_function_execute: boolean;
      public_default_acl: boolean;
      admin_reads_participants: boolean;
      admin_can_read_contact: boolean;
      admin_can_cancel: boolean;
    }>(`
      SELECT
        has_table_privilege('iub_public_runtime', 'public.exchange_requests', 'INSERT') AS public_insert,
        has_table_privilege('iub_admin_runtime', 'public.state_history', 'UPDATE') AS admin_update_history,
        has_schema_privilege('iub_public_runtime', 'public', 'CREATE') AS public_schema_create,
        has_function_privilege('iub_public_runtime', 'public.reserve_copy(bigint,bigint,bytea,uuid)', 'EXECUTE') AS reserve_execute,
        has_function_privilege('iub_public_runtime', 'public.complete_exchange(bigint,uuid,bigint)', 'EXECUTE') AS complete_execute,
        has_table_privilege('iub_admin_runtime', 'public.participants', 'SELECT') AS admin_reads_participants,
        has_function_privilege('iub_admin_runtime', 'public.get_participant_contact(bigint,bigint)', 'EXECUTE') AS admin_can_read_contact,
        has_function_privilege('iub_admin_runtime', 'public.cancel_exchange(bigint,uuid,bigint,text)', 'EXECUTE') AS admin_can_cancel,
        EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
            LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
          WHERE n.nspname = 'public' AND acl.grantee = 0
            AND acl.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
        ) AS public_group_write,
        EXISTS (
          SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
            LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          WHERE n.nspname = 'public' AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
        ) AS public_group_function_execute,
        EXISTS (
          SELECT 1 FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) acl
          WHERE d.defaclnamespace = 'public'::regnamespace AND acl.grantee = 0
        ) AS public_default_acl
    `);
    expect(privileges.rows[0]).toEqual({
      public_insert: false,
      admin_update_history: false,
      public_schema_create: false,
      reserve_execute: true,
      complete_execute: false,
      public_group_write: false,
      public_group_function_execute: false,
      public_default_acl: false,
      admin_reads_participants: false,
      admin_can_read_contact: true,
      admin_can_cancel: true,
    });

    await database.exec("SET ROLE iub_public_runtime");
    const catalog = await database.query("SELECT count(*)::int FROM public.available_catalog");
    expect(catalog.rows[0]).toBeTruthy();
    await expect(database.query("SELECT * FROM public.participants")).rejects.toThrow();
    await expect(database.query("CREATE TABLE public.runtime_ddl_probe (id integer)")).rejects.toThrow();
    await database.exec("RESET ROLE");
  });

  it("rejects duplicate open requests and invalid state transitions", async () => {
    const { copyId } = await createInstitutionalCopy();
    const participant = await createParticipantAndRequest("duplicate-check", copyId, "2");
    await expect(
      createParticipantAndRequest("duplicate-check-2", copyId, "3").then(async (second) => {
        await database.query(
          `INSERT INTO public.exchange_requests
            (request_code, participant_id, requested_copy_id, privacy_consent_id, request_access_token_sha256, idempotency_key)
           SELECT 'REQUEST-DUP', $1, $2, pc.id, $3, $4 FROM public.privacy_consents pc WHERE pc.participant_id = $1 LIMIT 1`,
          [second.participantId, copyId, digest(33), "00000000-0000-4000-8000-000000000003"],
        );
      }),
    ).rejects.toThrow();

    const actor = await createActor("reviewer", ["requests.review"]);
    await expect(
      database.query("SELECT public.set_request_status($1, 'approved', $2, 'skip')", [participant.requestId, actor.id]),
    ).rejects.toThrow();
    await expect(
      database.query("UPDATE public.exchange_requests SET status = 'completed' WHERE id = $1", [participant.requestId]),
    ).rejects.toThrow();
    const request = await database.query<{ status: string }>(
      "SELECT status FROM public.exchange_requests WHERE id = $1",
      [participant.requestId],
    );
    expect(request.rows[0]?.status).toBe("pending");
  });

  it("records consent grants and withdrawals immutably and permits a new consent version event", async () => {
    const { copyId } = await createInstitutionalCopy("IUB-CONSENT-1");
    const participant = await createParticipantAndRequest("consent", copyId, "10");
    const privacyAdmin = await createActor("privacy-admin", ["privacy.withdraw"]);
    const contactReader = await createActor("contact-reader", ["participants.read_contact"]);

    const contact = await database.query<{
      participant_id: string;
      full_name_ciphertext: Buffer;
      email_ciphertext: Buffer;
    }>("SELECT * FROM public.get_participant_contact($1, $2)", [participant.participantId, contactReader.id]);
    expect(Number(contact.rows[0]?.participant_id)).toBe(participant.participantId);
    expect(contact.rows[0]).not.toHaveProperty("identity_ciphertext");
    const accessAudit = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.audit_events WHERE actor_user_id = $1 AND event_type = 'participant.contact_read'",
      [contactReader.id],
    );
    expect(accessAudit.rows[0]?.count).toBe(1);

    const initialEvents = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.privacy_consent_events WHERE consent_id = $1",
      [participant.consentId],
    );
    expect(initialEvents.rows[0]?.count).toBe(1);

    await database.query(
      "SELECT public.withdraw_privacy_consent($1, $2, $3, $4)",
      [participant.consentId, privacyAdmin.id, digest(101), "12000000-0000-4000-8000-000000000001"],
    );
    await database.query(
      "SELECT public.withdraw_privacy_consent($1, $2, $3, $4)",
      [participant.consentId, privacyAdmin.id, digest(101), "12000000-0000-4000-8000-000000000001"],
    );

    await expect(
      database.query(
        `INSERT INTO public.exchange_requests
          (request_code, participant_id, requested_copy_id, privacy_consent_id, request_access_token_sha256, idempotency_key)
         VALUES ('REQUEST-REVOKED', $1, $2, $3, $4, $5)`,
        [participant.participantId, copyId, participant.consentId, digest(102), "13000000-0000-4000-8000-000000000001"],
      ),
    ).rejects.toThrow(/active consent/);

    await database.query(
      `INSERT INTO public.privacy_consents
        (participant_id, notice_version, purpose, consented_at, evidence_sha256, capture_channel, idempotency_key)
       VALUES ($1, 'notice-2026-01', 'book_exchange', clock_timestamp(), $2, 'web', $3)`,
      [participant.participantId, digest(103), "14000000-0000-4000-8000-000000000001"],
    );
    const events = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.privacy_consent_events WHERE participant_id = $1",
      [participant.participantId],
    );
    expect(events.rows[0]?.count).toBe(3);
    await expect(
      database.query("UPDATE public.privacy_consent_events SET event_type = 'granted' WHERE participant_id = $1", [participant.participantId]),
    ).rejects.toThrow();
  });

  it("rejects cross-request offers and target copies", async () => {
    const { copyId, bibId } = await createInstitutionalCopy("IUB-FK-1");
    const secondCopy = await database.query<{ id: string }>(
      `INSERT INTO public.copies
        (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
       VALUES ($1, 'IUB-FK-2', 'good', 'available', 'preexisting') RETURNING id`,
      [bibId],
    );
    const first = await createParticipantAndRequest("fk-1", copyId, "8");
    const second = await createParticipantAndRequest("fk-2", Number(secondCopy.rows[0]!.id), "9");
    const secondOffer = await database.query<{ id: string }>(
      "SELECT id FROM public.offered_books WHERE request_id = $1",
      [second.requestId],
    );
    await expect(
      database.query(
        "INSERT INTO public.receptions (request_id, offered_book_id, receipt_code) VALUES ($1, $2, 'BAD-RECEIPT')",
        [first.requestId, Number(secondOffer.rows[0]!.id)],
      ),
    ).rejects.toThrow();
    const firstOffer = await database.query<{ id: string }>(
      "SELECT id FROM public.offered_books WHERE request_id = $1",
      [first.requestId],
    );
    const reception = await database.query<{ id: string }>(
      "INSERT INTO public.receptions (request_id, offered_book_id, receipt_code) VALUES ($1, $2, 'GOOD-RECEIPT') RETURNING id",
      [first.requestId, Number(firstOffer.rows[0]!.id)],
    );
    await expect(
      database.query(
        `INSERT INTO public.exchanges (request_id, institutional_copy_id, offered_reception_id, planning_key)
         VALUES ($1, $2, $3, '20000000-0000-4000-8000-000000000099')`,
        [first.requestId, Number(secondCopy.rows[0]!.id), Number(reception.rows[0]!.id)],
      ),
    ).rejects.toThrow();
  });

  it("does not admit an unevaluated offer or create a copy before admission", async () => {
    const workflow = await runToReceptionInCustody();
    await expect(
      database.query(
        "SELECT public.authorize_inventory_admission($1, $2, $3)",
        [workflow.receptionId, workflow.actor.manager.id, "80000000-0000-4000-8000-000000000002"],
      ),
    ).rejects.toThrow();
    const copies = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.copies WHERE provenance_type = 'exchange_received'",
    );
    expect(copies.rows[0]?.count).toBe(0);
    await expect(
      database.query(
        `INSERT INTO public.copies (bibliographic_record_id, inventory_code, physical_condition, provenance_type, source_admission_id, ownership_acquired_at)
         VALUES (1, 'BAD-01', 'good', 'exchange_received', 999, clock_timestamp())`,
      ),
    ).rejects.toThrow();
  });

  it("requires the per-request proof before reserving", async () => {
    const actor = await createActor("token-policy", ["reservations.configure"]);
    await database.query("SELECT public.set_reservation_policy(3600, $1)", [actor.id]);
    const { copyId } = await createInstitutionalCopy("IUB-TOKEN");
    const request = await createParticipantAndRequest("token-check", copyId, "7");

    await expect(
      database.query("SELECT * FROM public.reserve_copy($1, $2, $3, $4)", [
        copyId,
        request.requestId,
        digest(250),
        "d1000000-0000-4000-8000-000000000001",
      ]),
    ).rejects.toThrow();
    const reservationCount = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.reservations WHERE request_id = $1",
      [request.requestId],
    );
    expect(reservationCount.rows[0]?.count).toBe(0);
  });

  it("closes the exchange atomically only after admission and both evidenced deliveries", async () => {
    const workflow = await runToReceptionInCustody();
    await admitOffer(workflow);

    const admission = await database.query<{ status: string }>(
      "SELECT status FROM public.inventory_admissions WHERE id = $1",
      [workflow.admissionId],
    );
    expect(admission.rows[0]?.status).toBe("admitted");
    const receivedCopy = await database.query<{ availability: string }>(
      "SELECT availability FROM public.copies WHERE id = $1",
      [workflow.offeredCopyId],
    );
    expect(receivedCopy.rows[0]?.availability).toBe("unavailable");

    await database.query("SELECT public.enable_received_copy($1, $2)", [workflow.admissionId, workflow.actor.manager.id]);
    await database.query("SELECT public.start_exchange($1, $2)", [workflow.exchangeId, workflow.actor.manager.id]);
    await database.query(
      `UPDATE public.reservations SET created_at = clock_timestamp() - interval '1 hour',
         expires_at = clock_timestamp() - interval '1 second' WHERE request_id = $1`,
      [workflow.requestId],
    );
    const expiredDuringExchange = await database.query<{ expire_reservations: number }>(
      "SELECT public.expire_reservations($1, 10)",
      [workflow.actor.manager.id],
    );
    expect(Number(expiredDuringExchange.rows[0]?.expire_reservations)).toBe(0);

    await expect(
      database.query(
        "SELECT public.complete_exchange($1, $2, $3)",
        [workflow.exchangeId, "90000000-0000-4000-8000-000000000001", workflow.actor.manager.id],
      ),
    ).rejects.toThrow();

    const preComplete = await database.query<{ status: string; availability: string; movement_count: number }>(`
      SELECT e.status, c.availability,
        (SELECT count(*)::int FROM public.inventory_movements m WHERE m.exchange_id = e.id) AS movement_count
      FROM public.exchanges e JOIN public.copies c ON c.id = e.institutional_copy_id
      WHERE e.id = $1
    `, [workflow.exchangeId]);
    expect(preComplete.rows[0]).toEqual({ status: "in_process", availability: "reserved", movement_count: 0 });

    const handoverId = await database.query<{ schedule_delivery: string }>(
      `SELECT public.schedule_delivery($1, 'institutional_copy_handover', clock_timestamp() + interval '1 hour', $2, $3)`,
      [workflow.exchangeId, "a0000000-0000-4000-8000-000000000001", workflow.actor.manager.id],
    );
    const handoverReplay = await database.query<{ schedule_delivery: string }>(
      `SELECT public.schedule_delivery($1, 'institutional_copy_handover', clock_timestamp() + interval '1 hour', $2, $3)`,
      [workflow.exchangeId, "a0000000-0000-4000-8000-000000000001", workflow.actor.manager.id],
    );
    expect(handoverReplay.rows[0]?.schedule_delivery).toBe(handoverId.rows[0]?.schedule_delivery);
    await expect(
      database.query(
        `SELECT public.schedule_delivery($1, 'institutional_copy_handover', clock_timestamp() + interval '1 hour', $2, $3)`,
        [workflow.exchangeId, "a0000000-0000-4000-8000-000000000002", workflow.actor.manager.id],
      ),
    ).rejects.toThrow();
    await database.query(
      "SELECT public.confirm_delivery($1, $2, 'receipt/handover-1', 'Library desk', $3)",
      [Number(handoverId.rows[0]!.schedule_delivery), workflow.actor.receiver.id, "a0000000-0000-4000-8000-000000000001"],
    );

    const completionKey = "b0000000-0000-4000-8000-000000000001";
    await database.exec(`
      CREATE FUNCTION public.test_fail_exchange_commit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.status = 'completed' THEN RAISE EXCEPTION 'test rollback sentinel'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER zz_test_fail_exchange_commit
      AFTER UPDATE OF status ON public.exchanges
      FOR EACH ROW EXECUTE FUNCTION public.test_fail_exchange_commit();
    `);
    await expect(
      database.query("SELECT public.complete_exchange($1, $2, $3)", [workflow.exchangeId, completionKey, workflow.actor.manager.id]),
    ).rejects.toThrow(/test rollback sentinel/);
    const rolledBack = await database.query<{ exchange_status: string; request_status: string; copy_status: string; reservation_status: string; movement_count: number }>(`
      SELECT e.status AS exchange_status, r.status AS request_status, c.availability AS copy_status,
        res.status AS reservation_status,
        (SELECT count(*)::int FROM public.inventory_movements m WHERE m.exchange_id = e.id) AS movement_count
      FROM public.exchanges e
      JOIN public.exchange_requests r ON r.id = e.request_id
      JOIN public.copies c ON c.id = e.institutional_copy_id
      JOIN public.reservations res ON res.request_id = r.id
      WHERE e.id = $1
    `, [workflow.exchangeId]);
    expect(rolledBack.rows[0]).toEqual({
      exchange_status: "in_process",
      request_status: "in_process",
      copy_status: "reserved",
      reservation_status: "converted",
      movement_count: 0,
    });
    await database.exec("DROP TRIGGER zz_test_fail_exchange_commit ON public.exchanges; DROP FUNCTION public.test_fail_exchange_commit();");

    await database.query("SELECT public.complete_exchange($1, $2, $3)", [workflow.exchangeId, completionKey, workflow.actor.manager.id]);
    await database.query("SELECT public.complete_exchange($1, $2, $3)", [workflow.exchangeId, completionKey, workflow.actor.manager.id]);

    const completed = await database.query<{ request_status: string; exchange_status: string; institutional_availability: string; movement_count: number }>(`
      SELECT r.status AS request_status, e.status AS exchange_status, c.availability AS institutional_availability,
        (SELECT count(*)::int FROM public.inventory_movements m WHERE m.exchange_id = e.id) AS movement_count
      FROM public.exchanges e
      JOIN public.exchange_requests r ON r.id = e.request_id
      JOIN public.copies c ON c.id = e.institutional_copy_id
      WHERE e.id = $1
    `, [workflow.exchangeId]);
    expect(completed.rows[0]).toEqual({
      request_status: "completed",
      exchange_status: "completed",
      institutional_availability: "retired",
      movement_count: 2,
    });
    const histories = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.state_history WHERE entity_type IN ('exchange', 'exchange_request') AND entity_id = $1",
      [workflow.exchangeId],
    );
    expect(histories.rows[0]?.count).toBeGreaterThan(1);
  });

  it("expires reservations and restores availability with a movement", async () => {
    const actor = await createActor("policy-admin", ["reservations.configure", "reservations.expire"]);
    await database.query("SELECT public.set_reservation_policy(3600, $1)", [actor.id]);
    const { copyId } = await createInstitutionalCopy("IUB-EXPIRE");
    const request = await createParticipantAndRequest("expiry", copyId, "4");
    const key = "c0000000-0000-4000-8000-000000000001";
    await database.query("SELECT public.reserve_copy($1, $2, $3, $4)", [copyId, request.requestId, request.accessHash, key]);
    await database.query(
      "UPDATE public.reservations SET created_at = clock_timestamp() - interval '1 hour', expires_at = clock_timestamp() - interval '1 second' WHERE idempotency_key = $1",
      [key],
    );

    const expired = await database.query<{ expire_reservations: number }>("SELECT public.expire_reservations($1, 10)", [actor.id]);
    expect(Number(expired.rows[0]?.expire_reservations)).toBe(1);
    const state = await database.query<{ reservation_status: string; availability: string; release_movements: number }>(`
      SELECT r.status AS reservation_status, c.availability,
        (SELECT count(*)::int FROM public.inventory_movements m WHERE m.copy_id = c.id AND m.movement_type = 'reservation_released') AS release_movements
      FROM public.reservations r JOIN public.copies c ON c.id = r.copy_id WHERE r.idempotency_key = $1
    `, [key]);
    expect(state.rows[0]).toEqual({ reservation_status: "expired", availability: "available", release_movements: 1 });
  });

  it("serializes simultaneous reservations for the same copy", async () => {
    const actor = await createActor("reservation-admin", ["reservations.configure"]);
    await database.query("SELECT public.set_reservation_policy(3600, $1)", [actor.id]);
    const { copyId } = await createInstitutionalCopy("IUB-RACE");
    const first = await createParticipantAndRequest("race-1", copyId, "5");
    const second = await createParticipantAndRequest("race-2", copyId, "6");
    const attempts = await Promise.allSettled([
      database.query("SELECT * FROM public.reserve_copy($1, $2, $3, $4)", [copyId, first.requestId, first.accessHash, "d0000000-0000-4000-8000-000000000001"]),
      database.query("SELECT * FROM public.reserve_copy($1, $2, $3, $4)", [copyId, second.requestId, second.accessHash, "d0000000-0000-4000-8000-000000000002"]),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const active = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.reservations WHERE copy_id = $1 AND status = 'active'",
      [copyId],
    );
    expect(active.rows[0]?.count).toBe(1);
  });

  it("rejected books require a documented return and never create institutional copies", async () => {
    const workflow = await runToReceptionInCustody();
    await database.query(
      `SELECT public.evaluate_reception($1, $2, 'rejected', 'poor', 'rejected condition', $3, NULL)`,
      [workflow.receptionId, workflow.actor.evaluator.id, "e0000000-0000-4000-8000-000000000001"],
    );
    await database.query("SELECT public.request_reception_return($1, $2, 'rejected')", [workflow.receptionId, workflow.actor.manager.id]);
    const returnId = await database.query<{ schedule_delivery: string }>(
      `SELECT public.schedule_delivery($1, 'offered_book_return', clock_timestamp() + interval '1 hour', $2, $3)`,
      [workflow.exchangeId, "f0000000-0000-4000-8000-000000000001", workflow.actor.manager.id],
    );
    await database.query(
      "SELECT public.confirm_delivery($1, $2, 'receipt/return-1', 'Participant handoff', $3)",
      [Number(returnId.rows[0]!.schedule_delivery), workflow.actor.receiver.id, "f0000000-0000-4000-8000-000000000001"],
    );

    const result = await database.query<{ reception_status: string; transfers: number; admission_count: number; received_copies: number }>(`
      SELECT r.status AS reception_status,
        (SELECT count(*)::int FROM public.ownership_transfers t WHERE t.reception_id = r.id) AS transfers,
        (SELECT count(*)::int FROM public.inventory_admissions a WHERE a.reception_id = r.id) AS admission_count,
        (SELECT count(*)::int FROM public.copies c WHERE c.provenance_type = 'exchange_received') AS received_copies
      FROM public.receptions r WHERE r.id = $1
    `, [workflow.receptionId]);
    expect(result.rows[0]).toEqual({ reception_status: "returned", transfers: 0, admission_count: 0, received_copies: 0 });
    const request = await database.query<{ status: string; exchange_status: string; copy_availability: string; reservation_status: string }>(`
      SELECT r.status, e.status AS exchange_status, c.availability AS copy_availability, res.status AS reservation_status
      FROM public.exchange_requests r
      JOIN public.exchanges e ON e.request_id = r.id
      JOIN public.copies c ON c.id = r.requested_copy_id
      JOIN public.reservations res ON res.request_id = r.id
      WHERE r.id = $1
    `, [workflow.requestId]);
    expect(request.rows[0]).toEqual({ status: "rejected", exchange_status: "cancelled", copy_availability: "available", reservation_status: "released" });
  });

  it("cancels an in-process exchange atomically before handover and releases its hold", async () => {
    const workflow = await runToReceptionInCustody();
    await admitOffer(workflow);
    await database.query("SELECT public.enable_received_copy($1, $2)", [workflow.admissionId, workflow.actor.manager.id]);
    await database.query("SELECT public.start_exchange($1, $2)", [workflow.exchangeId, workflow.actor.manager.id]);
    await expect(
      database.query("SELECT public.set_request_status($1, 'cancelled', $2, 'direct')", [
        workflow.requestId,
        workflow.actor.manager.id,
      ]),
    ).rejects.toThrow(/cancel_exchange/);
    const handover = await database.query<{ schedule_delivery: string }>(
      `SELECT public.schedule_delivery($1, 'institutional_copy_handover', clock_timestamp() + interval '1 hour', $2, $3)`,
      [workflow.exchangeId, "a1000000-0000-4000-8000-000000000001", workflow.actor.manager.id],
    );

    const cancellationKey = "b1000000-0000-4000-8000-000000000001";
    await database.query(
      "SELECT public.cancel_exchange($1, $2, $3, 'cancel before physical handover')",
      [workflow.exchangeId, cancellationKey, workflow.actor.manager.id],
    );
    await database.query(
      "SELECT public.cancel_exchange($1, $2, $3, 'replayed cancellation')",
      [workflow.exchangeId, cancellationKey, workflow.actor.manager.id],
    );

    const result = await database.query<{
      request_status: string;
      exchange_status: string;
      copy_availability: string;
      reservation_status: string;
      delivery_status: string;
      exchange_out_count: number;
    }>(`
      SELECT r.status AS request_status, e.status AS exchange_status,
        c.availability AS copy_availability, res.status AS reservation_status,
        d.status AS delivery_status,
        (SELECT count(*)::int FROM public.inventory_movements m WHERE m.exchange_id = e.id AND m.movement_type = 'exchange_out') AS exchange_out_count
      FROM public.exchanges e
      JOIN public.exchange_requests r ON r.id = e.request_id
      JOIN public.copies c ON c.id = e.institutional_copy_id
      JOIN public.reservations res ON res.request_id = r.id
      JOIN public.deliveries d ON d.id = $2
      WHERE e.id = $1
    `, [workflow.exchangeId, Number(handover.rows[0]!.schedule_delivery)]);
    expect(result.rows[0]).toEqual({
      request_status: "cancelled",
      exchange_status: "cancelled",
      copy_availability: "available",
      reservation_status: "released",
      delivery_status: "cancelled",
      exchange_out_count: 0,
    });
  });
});
