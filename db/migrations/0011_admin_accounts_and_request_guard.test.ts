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
  "0010_inventory_batches.sql",
  "0011_admin_accounts_and_request_guard.sql",
];

const digest = (byte: number) => Buffer.alloc(32, byte);

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
  for (const name of migrationNames) await database.exec(await migrationText(name));
  await database.exec("COMMIT");
  await database.exec("RESET ROLE");
  return database;
}

describe("administrative account management", () => {
  let database: PGlite;
  let managerId: number;
  let managerRoleId: number;
  let reviewerRoleId: number;

  beforeEach(async () => {
    database = await createDatabase();
    const manager = await database.query<{ id: string }>(
      `INSERT INTO public.app_users (identity_issuer, identity_subject)
       VALUES ('local', 'account-manager') RETURNING id`,
    );
    managerId = Number(manager.rows[0]!.id);
    const managerRole = await database.query<{ id: string }>(
      `INSERT INTO public.roles (role_key, display_name) VALUES ('account_manager', 'Account manager') RETURNING id`,
    );
    managerRoleId = Number(managerRole.rows[0]!.id);
    await database.query("INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)", [managerId, managerRoleId]);
    await database.query(
      `INSERT INTO public.role_permissions (role_id, permission_id)
       SELECT $1, id FROM public.permissions WHERE permission_key = 'account.manage'`,
      [managerRoleId],
    );
    const reviewerRole = await database.query<{ id: string }>(
      `INSERT INTO public.roles (role_key, display_name) VALUES ('request_reviewer', 'Request reviewer') RETURNING id`,
    );
    reviewerRoleId = Number(reviewerRole.rows[0]!.id);
    await database.query(
      `INSERT INTO public.role_permissions (role_id, permission_id)
       SELECT $1, id FROM public.permissions WHERE permission_key = 'requests.review'`,
      [reviewerRoleId],
    );
  });

  afterEach(async () => {
    await database.close();
  });

  async function createAccount(subject: string): Promise<number> {
    const rows = await database.query<{ user_id: string }>(
      "SELECT public.admin_create_account($1, 'local', $2, $3) AS user_id",
      [managerId, subject, `${subject}@example.test`],
    );
    return Number(rows.rows[0]!.user_id);
  }

  it("grants account routines only to the administrative runtime", async () => {
    const privileges = await database.query<{
      admin_list: boolean;
      public_list: boolean;
      admin_create: boolean;
      public_create: boolean;
    }>(
      `SELECT
         has_function_privilege('iub_admin_runtime', 'public.admin_list_accounts(bigint)', 'EXECUTE') AS admin_list,
         has_function_privilege('iub_public_runtime', 'public.admin_list_accounts(bigint)', 'EXECUTE') AS public_list,
         has_function_privilege('iub_admin_runtime', 'public.admin_create_account(bigint,text,text,text)', 'EXECUTE') AS admin_create,
         has_function_privilege('iub_public_runtime', 'public.admin_create_account(bigint,text,text,text)', 'EXECUTE') AS public_create`,
    );
    expect(privileges.rows[0]).toEqual({
      admin_list: true,
      public_list: false,
      admin_create: true,
      public_create: false,
    });
  });

  it("lists accounts and creates actors without credentials", async () => {
    const userId = await createAccount("new-operator");
    const list = await database.query<{
      identity_subject: string;
      is_active: boolean;
      roles: unknown;
      permissions: unknown;
    }>("SELECT * FROM public.admin_list_accounts($1)", [managerId]);

    expect(list.rows).toHaveLength(2);
    const created = list.rows.find((row) => row.identity_subject === "new-operator");
    expect(created).toMatchObject({ is_active: true, roles: [], permissions: [] });
    expect(Number(userId)).toBeGreaterThan(0);

    const audit = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.audit_events WHERE event_type = 'account.created'",
    );
    expect(audit.rows[0]?.count).toBe(1);
  });

  it("assigns only roles the actor can already grant", async () => {
    const userId = await createAccount("new-evaluator");
    await expect(
      database.query("SELECT public.admin_assign_role($1, $2, $3)", [managerId, userId, reviewerRoleId]),
    ).rejects.toThrow(/permissions the actor does not hold/);

    await database.query("SELECT public.admin_assign_role($1, $2, $3)", [managerId, userId, managerRoleId]);
    const list = await database.query<{ roles: Array<{ roleKey: string }> }>(
      "SELECT * FROM public.admin_list_accounts($1) WHERE identity_subject = 'new-evaluator'",
      [managerId],
    );
    expect(list.rows[0]?.roles).toEqual([expect.objectContaining({ roleKey: "account_manager" })]);
  });

  it("blocks self-deactivation and self-role changes", async () => {
    await expect(
      database.query("SELECT public.admin_set_account_active($1, $2, FALSE)", [managerId, managerId]),
    ).rejects.toThrow(/own session/);
    await expect(
      database.query("SELECT public.admin_remove_role($1, $2, $3)", [managerId, managerId, managerRoleId]),
    ).rejects.toThrow(/own roles/);
  });

  it("allows deactivating another manager but never the current session", async () => {
    const second = await createAccount("second-manager");
    await database.query("SELECT public.admin_assign_role($1, $2, $3)", [managerId, second, managerRoleId]);
    await database.query("SELECT public.admin_set_account_active($1, $2, FALSE)", [managerId, second]);
    const third = await createAccount("third-manager");
    await database.query("SELECT public.admin_assign_role($1, $2, $3)", [managerId, third, managerRoleId]);
    await expect(
      database.query("SELECT public.admin_set_account_active($1, $2, FALSE)", [managerId, managerId]),
    ).rejects.toThrow(/own session/);
    await database.query("SELECT public.admin_set_account_active($1, $2, FALSE)", [managerId, third]);
    const activeManagers = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM public.app_users u
       JOIN public.user_roles ur ON ur.user_id = u.id
       JOIN public.role_permissions rp ON rp.role_id = ur.role_id
       JOIN public.permissions p ON p.id = rp.permission_id
       WHERE u.is_active AND p.permission_key = 'account.manage'`,
    );
    expect(activeManagers.rows[0]?.count).toBe(1);
  });
});

describe("request approval guard", () => {
  let database: PGlite;
  let reviewerId: number;
  let requestId: number;
  let copyId: number;

  beforeEach(async () => {
    database = await createDatabase();
    const reviewer = await database.query<{ id: string }>(
      `INSERT INTO public.app_users (identity_issuer, identity_subject)
       VALUES ('local', 'request-reviewer') RETURNING id`,
    );
    reviewerId = Number(reviewer.rows[0]!.id);
    const role = await database.query<{ id: string }>(
      `INSERT INTO public.roles (role_key, display_name) VALUES ('request_review', 'Request review') RETURNING id`,
    );
    await database.query("INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)", [reviewerId, Number(role.rows[0]!.id)]);
    await database.query(
      `INSERT INTO public.role_permissions (role_id, permission_id)
       SELECT $1, id FROM public.permissions WHERE permission_key = 'requests.review'`,
      [Number(role.rows[0]!.id)],
    );

    const publisher = await database.query<{ id: string }>(
      `INSERT INTO public.publishers (name, normalized_name) VALUES ('Approval Pub', 'approval-pub') RETURNING id`,
    );
    const bib = await database.query<{ id: string }>(
      `INSERT INTO public.bibliographic_records (title, author, publisher_id)
       VALUES ('Approval title', 'Approval author', $1) RETURNING id`,
      [Number(publisher.rows[0]!.id)],
    );
    const copy = await database.query<{ id: string }>(
      `INSERT INTO public.copies
       (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
       VALUES ($1, 'APPROVAL-COPY-1', 'good', 'maintenance', 'preexisting') RETURNING id`,
      [Number(bib.rows[0]!.id)],
    );
    copyId = Number(copy.rows[0]!.id);
    const participant = await database.query<{ id: string }>(
      `INSERT INTO public.participants
       (full_name, email, email_normalized, identity_ciphertext, identity_fingerprint)
       VALUES ('Test Participant', 'test@example.test', 'test@example.test', $1, $2) RETURNING id`,
      [digest(1), digest(2)],
    );
    await database.query(
      `INSERT INTO public.privacy_notices (version, content_sha256, approved_at)
       VALUES ('test-notice', $1, clock_timestamp())`,
      [digest(3)],
    );
    const consent = await database.query<{ id: string }>(
      `INSERT INTO public.privacy_consents
       (participant_id, notice_version, purpose, consented_at, evidence_sha256,
        capture_channel, idempotency_key)
       VALUES ($1, 'test-notice', 'book_exchange', clock_timestamp(), $2, 'web',
               '11111111-1111-4111-8111-111111111111') RETURNING id`,
      [Number(participant.rows[0]!.id), digest(4)],
    );
    const request = await database.query<{ id: string }>(
      `INSERT INTO public.exchange_requests
       (request_code, participant_id, requested_copy_id, status, privacy_notice_version,
        consented_at, privacy_consent_id)
       VALUES ('REQ-APPROVAL-1', $1, $2, 'under_review', 'test-notice', clock_timestamp(), $3)
       RETURNING id`,
      [Number(participant.rows[0]!.id), copyId, Number(consent.rows[0]!.id)],
    );
    requestId = Number(request.rows[0]!.id);
    await database.query(
      `INSERT INTO public.offered_books (request_id, title, author, declared_condition)
       VALUES ($1, 'Offered title', 'Offered author', 'good')`,
      [requestId],
    );
  });

  afterEach(async () => {
    await database.close();
  });

  it("requires a reason in the decision history", async () => {
    await expect(
      database.query(
        `INSERT INTO public.request_status_history
         (request_id, previous_status, new_status, changed_by, reason)
         VALUES ($1, 'under_review', 'approved', $2, '')`,
        [requestId, reviewerId],
      ),
    ).rejects.toThrow(/decision reason/);
  });

  it("rejects approval when the requested copy is not available or reserved", async () => {
    await expect(
      database.query("SELECT public.set_request_status($1, 'approved', $2, 'decision')", [requestId, reviewerId]),
    ).rejects.toThrow(/not available for approval/);
  });

  it("allows approval when the copy is available and does not create admissions", async () => {
    await database.query("UPDATE public.copies SET availability = 'available' WHERE id = $1", [copyId]);
    await database.query("SELECT public.set_request_status($1, 'approved', $2, 'decision')", [requestId, reviewerId]);
    const result = await database.query<{ status: string; admissions: number }>(
      `SELECT r.status, (SELECT count(*)::int FROM public.inventory_admissions) AS admissions
       FROM public.exchange_requests r WHERE r.id = $1`,
      [requestId],
    );
    expect(result.rows[0]).toEqual({ status: "approved", admissions: 0 });
  });

  it("repeats approval idempotently without duplicating history", async () => {
    await database.query("UPDATE public.copies SET availability = 'available' WHERE id = $1", [copyId]);
    await database.query("SELECT public.set_request_status($1, 'approved', $2, 'decision')", [requestId, reviewerId]);
    await database.query("SELECT public.set_request_status($1, 'approved', $2, 'decision')", [requestId, reviewerId]);
    const history = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.request_status_history
       WHERE request_id = $1 AND new_status = 'approved'`,
      [requestId],
    );
    expect(history.rows[0]?.count).toBe(1);
  });
});
