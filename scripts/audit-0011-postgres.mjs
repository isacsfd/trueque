import { Client } from "pg";
import { createHash, randomUUID } from "node:crypto";
const base = process.env.IUB_TEST_DATABASE_URL;
if (!base) throw new Error("IUB_TEST_DATABASE_URL is required");
const parsedBase = new URL(base);
if (!["localhost", "127.0.0.1", "::1", "postgres"].includes(parsedBase.hostname.toLowerCase())) {
  throw new Error(`Refusing non-local audit host: ${parsedBase.hostname}`);
}
if (!/test|disposable|audit/i.test(parsedBase.pathname)) {
  throw new Error("The audit database name must identify a disposable/test database.");
}
const run = Date.now().toString(36);
const digest = (s) => createHash("sha256").update(`${run}:${s}`).digest();
const url = (role) => { const u = new URL(base); u.username = role; u.password = ""; return u.toString(); };
const migrator = new Client({ connectionString: base });
const admin = new Client({ connectionString: url("iub_admin_runtime") });
await Promise.all([migrator.connect(), admin.connect()]);
const errors = [];
async function expectCode(promise, code, label) {
  try { await promise; errors.push(`${label}: expected ${code}, operation succeeded`); return false; }
  catch (e) { if (e.code !== code) { errors.push(`${label}: expected ${code}, got ${e.code}: ${e.message}`); return false; } return true; }
}
try {
  const manager = await migrator.query("INSERT INTO public.app_users (identity_issuer, identity_subject) VALUES ('audit','manager-'||$1) RETURNING id", [run]);
  const managerId = Number(manager.rows[0].id);
  const managerRole = await migrator.query("INSERT INTO public.roles (role_key, display_name) VALUES ('audit_manager_'||$1,'Audit manager') RETURNING id", [run.replace(/-/g,'_')]);
  const managerRoleId = Number(managerRole.rows[0].id);
  await migrator.query("INSERT INTO public.user_roles (user_id,role_id) VALUES ($1,$2)", [managerId, managerRoleId]);
  await migrator.query("INSERT INTO public.role_permissions (role_id,permission_id) SELECT $1,id FROM public.permissions WHERE permission_key IN ('account.manage','inventory.batches.import','inventory.batches.confirm','inventory.batches.read')", [managerRoleId]);
  const reviewerRole = await migrator.query("INSERT INTO public.roles (role_key, display_name) VALUES ('audit_reviewer_'||$1,'Audit reviewer') RETURNING id", [run.replace(/-/g,'_')]);
  const reviewerRoleId = Number(reviewerRole.rows[0].id);
  await migrator.query("INSERT INTO public.role_permissions (role_id,permission_id) SELECT $1,id FROM public.permissions WHERE permission_key='requests.review'", [reviewerRoleId]);
  const reviewer = await migrator.query("INSERT INTO public.app_users (identity_issuer, identity_subject) VALUES ('audit','reviewer-'||$1) RETURNING id", [run]);
  const reviewerId = Number(reviewer.rows[0].id);
  await migrator.query("INSERT INTO public.user_roles (user_id,role_id) VALUES ($1,$2)", [reviewerId, reviewerRoleId]);

  const created = await admin.query("SELECT public.admin_create_account($1,'audit',$2,$3) AS user_id", [managerId, `operator-${run}`, `operator-${run}@example.test`]);
  const operatorId = Number(created.rows[0].user_id);
  const list = await admin.query("SELECT * FROM public.admin_list_accounts($1)", [managerId]);
  const operator = list.rows.find((r) => Number(r.user_id) === operatorId);
  const columns = await migrator.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='app_users' ORDER BY column_name");
  const passwordColumns = columns.rows.filter((r) => /password|hash|secret|token/i.test(r.column_name));

  const escalationBlocked = await expectCode(admin.query("SELECT public.admin_assign_role($1,$2,$3)", [managerId, operatorId, reviewerRoleId]), "42501", "role escalation");
  await admin.query("SELECT public.admin_assign_role($1,$2,$3)", [managerId, operatorId, managerRoleId]);
  const assigned = await admin.query("SELECT roles FROM public.admin_list_accounts($1) WHERE user_id=$2", [managerId, operatorId]);
  await admin.query("SELECT public.admin_remove_role($1,$2,$3)", [managerId, operatorId, managerRoleId]);
  const removed = await admin.query("SELECT roles FROM public.admin_list_accounts($1) WHERE user_id=$2", [managerId, operatorId]);
  const reviewerCannotList = await expectCode(admin.query("SELECT * FROM public.admin_list_accounts($1)", [reviewerId]), "42501", "account list without permission");
  const selfRoleBlocked = await expectCode(admin.query("SELECT public.admin_assign_role($1,$2,$3)", [managerId, managerId, managerRoleId]), "42501", "self role change");
  const selfDeactivateBlocked = await expectCode(admin.query("SELECT public.admin_set_account_active($1,$2,FALSE)", [managerId, managerId]), "42501", "self deactivation");
  await admin.query("SELECT public.admin_set_account_active($1,$2,FALSE)", [managerId, operatorId]);
  await admin.query("SELECT public.admin_set_account_active($1,$2,TRUE)", [managerId, operatorId]);
  const grant = await migrator.query(`SELECT
    has_function_privilege('iub_admin_runtime','public.assert_actor_permission(bigint,text)','EXECUTE') AS assert_ok,
    has_function_privilege('iub_admin_runtime','public.admin_list_accounts(bigint)','EXECUTE') AS list_ok,
    has_function_privilege('iub_public_runtime','public.admin_list_accounts(bigint)','EXECUTE') AS public_list_ok,
    has_table_privilege('iub_admin_runtime','public.request_status_history','SELECT') AS history_ok,
    has_table_privilege('iub_public_runtime','public.offered_book_evidence','SELECT') AS public_evidence_read,
    has_table_privilege('iub_admin_runtime','public.offered_book_evidence','SELECT') AS admin_evidence_read,
    has_function_privilege('iub_public_runtime','public.get_offered_book_evidence(bigint,bytea)','EXECUTE') AS public_evidence_function`);
  const triggers = await migrator.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('public.exchange_requests'::regclass,'public.request_status_history'::regclass,'public.copies'::regclass) ORDER BY tgname");
  const audit = await migrator.query("SELECT event_type, metadata FROM public.audit_events WHERE resource_type='app_user' AND resource_id=$1 ORDER BY id", [String(operatorId)]);
  const activeManagers = await migrator.query(`SELECT count(DISTINCT u.id)::int AS count
    FROM public.app_users u
    JOIN public.user_roles ur ON ur.user_id=u.id
    JOIN public.role_permissions rp ON rp.role_id=ur.role_id
    JOIN public.permissions p ON p.id=rp.permission_id
    WHERE u.is_active AND p.permission_key='account.manage' AND u.identity_issuer='audit' AND u.identity_subject='manager-'||$1`, [run]);

  const publisher = await migrator.query("INSERT INTO public.publishers (name, normalized_name) VALUES ('Audit Pub '||$1,'audit-pub-'||$1) RETURNING id", [run]);
  const bib = await migrator.query("INSERT INTO public.bibliographic_records (title,author,publisher_id) VALUES ('Audit title '||$1,'Audit author',$2) RETURNING id", [run, Number(publisher.rows[0].id)]);
  const copy = await migrator.query("INSERT INTO public.copies (bibliographic_record_id,inventory_code,physical_condition,availability,provenance_type) VALUES ($1,'AUDIT-'||$2,'good','maintenance','preexisting') RETURNING id", [Number(bib.rows[0].id), run.toUpperCase()]);
  const copyId = Number(copy.rows[0].id);
  const participant = await migrator.query("INSERT INTO public.participants (full_name,email,email_normalized,identity_ciphertext,identity_fingerprint) VALUES ('Audit Participant','audit@example.test','audit@example.test',$1,$2) RETURNING id", [digest('id'), digest('fp')]);
  await migrator.query("INSERT INTO public.privacy_notices (version,content_sha256,approved_at) VALUES ('audit-notice-'||$1,$2,clock_timestamp()) ON CONFLICT (version) DO NOTHING", [run, digest('notice')]);
  const consent = await migrator.query("INSERT INTO public.privacy_consents (participant_id,notice_version,purpose,consented_at,evidence_sha256,capture_channel,idempotency_key) VALUES ($1,'audit-notice-'||$2,'book_exchange',clock_timestamp(),$3,'web',gen_random_uuid()) RETURNING id", [Number(participant.rows[0].id), run, digest('consent')]);
  const request = await migrator.query("INSERT INTO public.exchange_requests (request_code,participant_id,requested_copy_id,status,privacy_notice_version,consented_at,privacy_consent_id) VALUES ('AUDIT-REQ-'||$1,$2,$3,'under_review','audit-notice-'||$1,clock_timestamp(),$4) RETURNING id", [run, Number(participant.rows[0].id), copyId, Number(consent.rows[0].id)]);
  const requestId = Number(request.rows[0].id);
  await migrator.query("INSERT INTO public.offered_books (request_id,title,author,declared_condition) VALUES ($1,'Audit offered','Audit author','good')", [requestId]);
  const approvalBlocked = await expectCode(admin.query("SELECT public.set_request_status($1,'approved',$2,'audit approval')", [requestId, reviewerId]), "23514", "approval of maintenance copy");
  await migrator.query("UPDATE public.copies SET availability='available' WHERE id=$1", [copyId]);
  await admin.query("SELECT public.set_request_status($1,'approved',$2,'audit approval')", [requestId, reviewerId]);
  const approvalState = await migrator.query("SELECT r.status,(SELECT count(*)::int FROM public.inventory_admissions a JOIN public.receptions rec ON rec.id=a.reception_id WHERE rec.request_id=r.id) AS admissions,(SELECT count(*)::int FROM public.receptions WHERE request_id=r.id) AS receptions,(SELECT count(*)::int FROM public.inventory_movements m WHERE m.copy_id=$2) AS movements FROM public.exchange_requests r WHERE r.id=$1", [requestId, copyId]);
  const history = await migrator.query("SELECT previous_status,new_status,reason,changed_by FROM public.request_status_history WHERE request_id=$1 ORDER BY id", [requestId]);

  const copy2 = await migrator.query("INSERT INTO public.copies (bibliographic_record_id,inventory_code,physical_condition,availability,provenance_type) VALUES ($1,'AUDIT2-'||$2,'good','available','preexisting') RETURNING id", [Number(bib.rows[0].id), run.toUpperCase()]);
  const copy2Id = Number(copy2.rows[0].id);
  const request2 = await migrator.query("INSERT INTO public.exchange_requests (request_code,participant_id,requested_copy_id,status,privacy_notice_version,consented_at,privacy_consent_id) VALUES ('AUDIT-REQ2-'||$1,$2,$3,'under_review','audit-notice-'||$1,clock_timestamp(),$4) RETURNING id", [run, Number(participant.rows[0].id), copy2Id, Number(consent.rows[0].id)]);
  const request2Id = Number(request2.rows[0].id);
  await migrator.query("INSERT INTO public.offered_books (request_id,title,author,declared_condition) VALUES ($1,'Audit offered 2','Audit author','good')", [request2Id]);
  await admin.query("SELECT public.set_request_status($1,'rejected',$2,'audit rejection reason')", [request2Id, reviewerId]);
  const rejectionHistory = await migrator.query("SELECT new_status,reason FROM public.request_status_history WHERE request_id=$1", [request2Id]);
  const emptyReasonBlocked = await expectCode(migrator.query("INSERT INTO public.request_status_history (request_id,previous_status,new_status,changed_by,reason) VALUES ($1,'under_review','approved',$2,'')", [request2Id, reviewerId]), "23514", "empty decision reason");

  const batchCode = `AUDIT-BATCH-${run.toUpperCase()}`;
  const batchRows = [{
    source_row: 2,
    raw: { TITULO: "Lote audit", AUTOR: "Autora" },
    mapped: {
      title: "Lote audit", author: "Autora", publisher: null, genre: null,
      isbn: null, isbn_normalized: null, inventory_code: batchCode,
      location: "AUDIT", observations: null, source_number: "2", copy_number: "1",
    },
    status: "valid", errors: [], warnings: [], inventory_code: batchCode,
  }];
  const stored = await admin.query(
    "SELECT * FROM public.store_inventory_batch($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11)",
    ["audit-lote.xlsx", digest("batch"), 1024, "Hoja1", 1, JSON.stringify({ title: "TITULO", author: "AUTOR" }), JSON.stringify(batchRows), managerId, randomUUID(), `audit-batch-${run}.xlsx`, "Lote de auditoría"],
  );
  const batchId = Number(stored.rows[0].batch_id);
  const confirmed = await admin.query("SELECT * FROM public.confirm_inventory_batch($1,$2,$3)", [batchId, managerId, randomUUID()]);
  const confirmedAgain = await admin.query("SELECT * FROM public.confirm_inventory_batch($1,$2,$3)", [batchId, managerId, randomUUID()]);
  if (confirmedAgain.rows[0].status !== confirmed.rows[0].status
      || Number(confirmedAgain.rows[0].inserted_rows) !== Number(confirmed.rows[0].inserted_rows)
      || Number(confirmedAgain.rows[0].reused_rows) !== Number(confirmed.rows[0].reused_rows)) {
    errors.push("batch confirmation replay returned different counts");
  }
  const batchCopy = await migrator.query("SELECT inventory_code,availability,physical_condition,verified_at,provenance_type FROM public.copies WHERE inventory_code=$1", [batchCode]);
  const batchMovements = await migrator.query("SELECT count(*)::int AS count FROM public.inventory_movements m JOIN public.copies c ON c.id=m.copy_id WHERE c.inventory_code=$1", [batchCode]);
  const cancelled = await admin.query(
    "SELECT * FROM public.store_inventory_batch($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11)",
    ["audit-cancel.xlsx", digest("batch-cancel"), 1024, "Hoja1", 1, JSON.stringify({ title: "TITULO", author: "AUTOR" }), JSON.stringify(batchRows.map((row) => ({ ...row, source_row: 3, mapped: { ...row.mapped, inventory_code: `${batchCode}-CANCEL` }, inventory_code: `${batchCode}-CANCEL` }))), managerId, randomUUID(), `audit-cancel-${run}.xlsx`, "Lote cancelado"],
  );
  const cancelledState = await admin.query("SELECT * FROM public.cancel_inventory_batch($1,$2,$3)", [Number(cancelled.rows[0].batch_id), managerId, randomUUID()]);
  const cancelledCopy = await migrator.query("SELECT count(*)::int AS count FROM public.copies WHERE inventory_code=$1", [`${batchCode}-CANCEL`]);

  console.log(JSON.stringify({
    run,
    account: {
      created: Boolean(operator),
      noCredentialColumns: passwordColumns.map((r) => r.column_name),
      escalationBlocked, selfRoleBlocked, selfDeactivateBlocked,
      roleAssigned: assigned.rows[0].roles.length, roleRemoved: removed.rows[0].roles.length, reviewerCannotList,
      auditEvents: audit.rows.map((r) => r.event_type),
      activeManagersAfterSelfAttempt: activeManagers.rows[0].count,
    },
    grants: grant.rows[0],
    triggers: triggers.rows.map((r) => r.tgname),
    approval: { approvalBlocked, state: approvalState.rows[0], history: history.rows },
    rejection: { history: rejectionHistory.rows, emptyReasonBlocked },
    batches: {
      stored: stored.rows[0].status,
      confirmed: confirmed.rows[0].status,
      replay: confirmedAgain.rows[0],
      copy: batchCopy.rows[0],
      movements: batchMovements.rows[0].count,
      cancelled: cancelledState.rows[0].status,
      cancelledCopies: cancelledCopy.rows[0].count,
    },
    errors,
  }, null, 2));
  if (errors.length) process.exitCode = 1;
} finally {
  await Promise.allSettled([migrator.end(), admin.end()]);
}
