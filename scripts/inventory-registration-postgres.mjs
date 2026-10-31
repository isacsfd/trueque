import assert from "node:assert/strict";
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
if (!/_test|_registration|_disposable/i.test(target.pathname)) {
  console.error("The database name must clearly identify a disposable test database.");
  process.exit(2);
}

const migrationNames = [
  "0001_initial_schema.sql",
  "0002_corrective_schema.sql",
  "0003_runtime_privileges.sql",
  "0004_p0_integrity.sql",
  "0005_participant_api.sql",
  "0020_inventory_integrity_repair.sql",
  "0022_inventory_registration.sql",
];

async function migrationText(name) {
  return readFile(new URL(`../db/migrations/${name}`, import.meta.url), "utf8");
}

async function connect(applicationName) {
  const client = new Client({ connectionString: baseUrl, application_name: applicationName });
  await client.connect();
  return client;
}

const setup = await connect("iub_registration_setup");
const clients = [];
try {
  await setup.query("DROP SCHEMA public CASCADE");
  await setup.query("CREATE SCHEMA public");
  await setup.query("GRANT USAGE, CREATE ON SCHEMA public TO iub_schema_migrator");
  for (const name of migrationNames) {
    await setup.query(await migrationText(name));
  }

  const user = await setup.query(
    `INSERT INTO public.app_users (identity_issuer, identity_subject)
     VALUES ('https://test', 'registration-concurrency-actor') RETURNING id`,
  );
  const actorId = Number(user.rows[0].id);
  const role = await setup.query(
    `INSERT INTO public.roles (role_key, display_name)
     VALUES ('registration_concurrency', 'Registration concurrency') RETURNING id`,
  );
  const roleId = Number(role.rows[0].id);
  await setup.query(
    `INSERT INTO public.role_permissions (role_id, permission_id)
     SELECT $1, id FROM public.permissions
     WHERE permission_key IN ('inventory.register', 'inventory.verify', 'inventory.publish')`,
    [roleId],
  );
  await setup.query("INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)", [actorId, roleId]);

  const first = await connect("iub_registration_first");
  const second = await connect("iub_registration_second");
  clients.push(first, second);

  const idempotencyKey = "11111111-1111-4111-8111-111111111111";
  const call = (client) => client.query(
    `SELECT * FROM public.register_institutional_copy(
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
     )`,
    [
      "Cien años de soledad",
      "Gabriel García Márquez",
      "Sudamericana",
      "Novela",
      null,
      null,
      "INV-CONCURRENT-001",
      "Estante A",
      "good",
      "Acta concurrente",
      true,
      actorId,
      idempotencyKey,
    ],
  );

  const [left, right] = await Promise.all([call(first), call(second)]);
  const created = [left.rows[0]?.created, right.rows[0]?.created].filter(Boolean);
  assert.equal(created.length, 1, "exactly one concurrent call must create the copy");
  assert.equal(left.rows[0]?.copy_id, right.rows[0]?.copy_id);
  console.log("ok - concurrent manual registration is serialized by idempotency key");

  const state = await setup.query(
    `SELECT count(*)::int AS copies,
            min(c.availability) AS availability,
            bool_and(c.verified_at IS NOT NULL) AS verified,
            bool_and(EXISTS (SELECT 1 FROM public.available_catalog ac WHERE ac.copy_id = c.id)) AS in_catalog
     FROM public.copies c WHERE c.inventory_code = 'INV-CONCURRENT-001'`,
  );
  assert.deepEqual(state.rows[0], {
    copies: 1,
    availability: "available",
    verified: true,
    in_catalog: true,
  });
  console.log("ok - eligible manual copy is verified and published exactly once");

  const movements = await setup.query(
    `SELECT count(*)::int AS count FROM public.inventory_movements
     WHERE copy_id = (SELECT id FROM public.copies WHERE inventory_code = 'INV-CONCURRENT-001')`,
  );
  assert.equal(movements.rows[0].count, 2);
  console.log("ok - received and publication movements are recorded without duplicates");

  const retry = await call(first);
  assert.equal(retry.rows[0]?.created, false);
  const copies = await setup.query(
    "SELECT count(*)::int AS count FROM public.copies WHERE inventory_code = 'INV-CONCURRENT-001'",
  );
  assert.equal(copies.rows[0].count, 1);
  console.log("ok - retry is idempotent and does not duplicate the copy");
} finally {
  await Promise.allSettled(clients.map((client) => client.end()));
  await setup.end();
}
