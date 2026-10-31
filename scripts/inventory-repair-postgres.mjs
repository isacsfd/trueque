import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { Client } from "pg";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);
const baseUrl = process.env.IUB_TEST_DATABASE_URL;
if (!baseUrl) {
  console.error("IUB_TEST_DATABASE_URL is required. Point it to a disposable local PostgreSQL database.");
  process.exit(2);
}

const target = new URL(baseUrl);
if (!LOCAL_HOSTS.has(target.hostname.toLowerCase())) {
  console.error(`Refusing non-local database host: ${target.hostname}`);
  process.exit(2);
}
if (!/_test|_repair|_concurrency/i.test(target.pathname)) {
  console.error("The database name must clearly identify a disposable test database.");
  process.exit(2);
}

const migrationNames = [
  "0001_initial_schema.sql",
  "0002_corrective_schema.sql",
  "0003_runtime_privileges.sql",
  "0004_p0_integrity.sql",
  "0005_participant_api.sql",
];
const repairMigration = "0020_inventory_integrity_repair.sql";

async function migrationText(name) {
  return readFile(new URL(`../db/migrations/${name}`, import.meta.url), "utf8");
}

async function connect() {
  const client = new Client({ connectionString: baseUrl, application_name: "iub_repair_postgres_test" });
  await client.connect();
  return client;
}

const migrator = await connect();
const clients = [];
try {
  await migrator.query("DROP SCHEMA public CASCADE");
  await migrator.query("CREATE SCHEMA public");
  await migrator.query("GRANT USAGE, CREATE ON SCHEMA public TO iub_schema_migrator");

  for (const name of migrationNames) {
    await migrator.query(await migrationText(name));
  }

  const actor = await migrator.query(
    `INSERT INTO public.app_users (identity_issuer, identity_subject)
     VALUES ('https://issuer.test', 'concurrency-repair-actor') RETURNING id`,
  );
  const actorId = Number(actor.rows[0].id);

  const publisher = await migrator.query(
    `INSERT INTO public.publishers (name, normalized_name)
     VALUES ('Concurrency Publisher', 'concurrency publisher') RETURNING id`,
  );
  const legacyBib = await migrator.query(
    `INSERT INTO public.bibliographic_records (title, author, publisher_id)
     VALUES ('Legacy Concurrent Book', 'Legacy Concurrent Author', $1) RETURNING id`,
    [Number(publisher.rows[0].id)],
  );
  const legacy = await migrator.query(
    `INSERT INTO public.copies
       (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
     VALUES ($1, 'LEGACY-CONCURRENT-001', 'good', 'available', 'institutional') RETURNING id`,
    [Number(legacyBib.rows[0].id)],
  );
  const legacyCopyId = Number(legacy.rows[0].id);

  await migrator.query(await migrationText(repairMigration));

  const role = await migrator.query(
    `INSERT INTO public.roles (role_key, display_name)
     VALUES ('concurrency_repair_role', 'Concurrency Repair Role') RETURNING id`,
  );
  await migrator.query(
    "INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)",
    [actorId, Number(role.rows[0].id)],
  );
  await migrator.query(
    `INSERT INTO public.role_permissions (role_id, permission_id)
     SELECT $1, id FROM public.permissions
     WHERE permission_key IN (
       'inventory.verify', 'inventory.publish', 'inventory.withdraw',
       'inventory.events.import', 'inventory.classify_synthetic'
     )`,
    [Number(role.rows[0].id)],
  );

  async function newCopy(label) {
    const bib = await migrator.query(
      `INSERT INTO public.bibliographic_records (title, author)
       VALUES ($1, $2) RETURNING id`,
      [`Concurrent ${label}`, `Author ${label}`],
    );
    const copy = await migrator.query(
      `INSERT INTO public.copies
         (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
       VALUES ($1, $2, 'good', 'unavailable', 'institutional') RETURNING id`,
      [Number(bib.rows[0].id), `CONCURRENT-${label}-${randomUUID()}`],
    );
    return Number(copy.rows[0].id);
  }

  async function parallel(operations) {
    for (let index = 0; index < operations.length; index += 1) {
      const client = await connect();
      clients.push(client);
    }
    return Promise.allSettled(operations.map((operation, index) => operation(clients[index])));
  }

  const withdrawKey = randomUUID();
  const withdrawResults = await parallel([
    (client) => client.query(
      "SELECT public.withdraw_copy($1, 'retired', 'concurrent withdrawal', $2, $3)",
      [legacyCopyId, actorId, withdrawKey],
    ),
    (client) => client.query(
      "SELECT public.withdraw_copy($1, 'retired', 'concurrent withdrawal', $2, $3)",
      [legacyCopyId, actorId, withdrawKey],
    ),
  ]);
  assert.deepEqual(withdrawResults.map((result) => result.status), ["fulfilled", "fulfilled"]);
  const withdrawState = await migrator.query(
    `SELECT c.availability,
            (SELECT count(*)::int FROM public.inventory_movements m
              WHERE m.copy_id = c.id AND m.idempotency_key = $1) AS movements,
            (SELECT count(*)::int FROM public.audit_events a
              WHERE a.resource_type = 'copy' AND a.resource_id = c.id::text
                AND a.event_type = 'inventory.copy_withdrawn') AS audits
     FROM public.copies c WHERE c.id = $2`,
    [withdrawKey, legacyCopyId],
  );
  assert.deepEqual(withdrawState.rows[0], { availability: "retired", movements: 1, audits: 1 });
  console.log("ok - concurrent withdrawal is serialized and idempotent");

  const publishCopyId = await newCopy("publish");
  await migrator.query("SELECT public.verify_institutional_copy($1, $2, 'evidence-concurrent')", [publishCopyId, actorId]);
  const publishKey = randomUUID();
  const publishResults = await parallel([
    (client) => client.query(
      "SELECT public.publish_institutional_copy($1, $2, $3)",
      [publishCopyId, actorId, publishKey],
    ),
    (client) => client.query(
      "SELECT public.publish_institutional_copy($1, $2, $3)",
      [publishCopyId, actorId, publishKey],
    ),
  ]);
  assert.deepEqual(publishResults.map((result) => result.status), ["fulfilled", "fulfilled"]);
  const publishState = await migrator.query(
    `SELECT c.availability,
            (SELECT count(*)::int FROM public.inventory_movements m
              WHERE m.copy_id = c.id AND m.idempotency_key = $1) AS movements
     FROM public.copies c WHERE c.id = $2`,
    [publishKey, publishCopyId],
  );
  assert.deepEqual(publishState.rows[0], { availability: "available", movements: 1 });
  console.log("ok - concurrent publication is serialized and idempotent");

  const importKey = randomUUID();
  const importPayload = JSON.stringify({
    bibs: [{ key: "B1", title: "Concurrent Imported Book", author: "Concurrent Import Author", publisher: "Concurrent Publisher", isbn: "", isbn_normalized: "" }],
    copies: [{ code: `IMPORT-${randomUUID()}`, bib_key: "B1", location: "Shelf" }],
  });
  const importResults = await parallel([
    (client) => client.query(
      "SELECT * FROM public.import_event_inventory('concurrent-event', $1::jsonb, $2, $3)",
      [importPayload, actorId, importKey],
    ),
    (client) => client.query(
      "SELECT * FROM public.import_event_inventory('concurrent-event', $1::jsonb, $2, $3)",
      [importPayload, actorId, importKey],
    ),
  ]);
  assert.deepEqual(importResults.map((result) => result.status), ["fulfilled", "fulfilled"]);
  const importState = await migrator.query(
    `SELECT
       (SELECT count(*)::int FROM public.inventory_event_imports WHERE idempotency_key = $1) AS imports,
       (SELECT count(*)::int FROM public.copies WHERE inventory_code = $2) AS copies`,
    [importKey, JSON.parse(importPayload).copies[0].code],
  );
  assert.deepEqual(importState.rows[0], { imports: 1, copies: 1 });
  console.log("ok - concurrent event import is serialized and idempotent");

  const demotionCopyId = await newCopy("demotion");
  await migrator.query("SELECT public.verify_institutional_copy($1, $2, 'evidence-demotion')", [demotionCopyId, actorId]);
  await migrator.query(
    "SELECT public.publish_institutional_copy($1, $2, $3)",
    [demotionCopyId, actorId, randomUUID()],
  );
  await assert.rejects(
    migrator.query("UPDATE public.copies SET availability = 'unavailable' WHERE id = $1", [demotionCopyId]),
    /authorized withdrawal/,
  );
  await migrator.query(
    "SELECT public.withdraw_copy($1, 'unavailable', 'authorized concurrency demotion', $2, $3)",
    [demotionCopyId, actorId, randomUUID()],
  );
  console.log("ok - direct demotion is blocked and authorized withdrawal succeeds");

  console.log("all inventory repair PostgreSQL tests passed");
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  await Promise.allSettled(clients.map((client) => client.end()));
  await migrator.end();
}
