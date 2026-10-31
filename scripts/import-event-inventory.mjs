#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { Client } from "pg";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);

function usage() {
  console.error(`Usage:
  node scripts/import-event-inventory.mjs --file <payload.json> --event-key <key> --actor-id <id> [--idempotency-key <uuid>] [--apply] [--database-url <url>] [--allow-remote]

Without --apply the script validates the payload and prints a dry-run summary.
It refuses non-local database hosts unless both --allow-remote and
IUB_ALLOW_REMOTE_IMPORT=1 are supplied. It never updates existing copies.`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (["apply", "allow-remote", "help"].includes(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function assertLocalHost(connectionString) {
  const host = new URL(connectionString).hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing non-local database host '${host}'. Use --allow-remote and IUB_ALLOW_REMOTE_IMPORT=1 only after explicit authorization.`,
    );
  }
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload must be a JSON object");
  if (!Array.isArray(payload.bibs) || payload.bibs.length === 0) throw new Error("payload.bibs must be a non-empty array");
  if (!Array.isArray(payload.copies) || payload.copies.length === 0) throw new Error("payload.copies must be a non-empty array");

  const keys = new Set();
  for (const bib of payload.bibs) {
    if (!bib || typeof bib.key !== "string" || !bib.key.trim()) throw new Error("every bib needs a non-empty key");
    if (keys.has(bib.key.trim())) throw new Error(`duplicate bib key: ${bib.key}`);
    keys.add(bib.key.trim());
    if (!bib.title || !bib.author) throw new Error(`bib ${bib.key} needs title and author`);
  }
  for (const copy of payload.copies) {
    if (!copy || typeof copy.code !== "string" || !copy.code.trim()) throw new Error("every copy needs a non-empty code");
    if (!copy.bib_key || !keys.has(copy.bib_key.trim())) throw new Error(`copy ${copy.code} references an unknown bib_key`);
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}

const file = args.file;
const eventKey = args["event-key"];
const actorId = Number(args["actor-id"] || 0);
const idempotencyKey = args["idempotency-key"] || randomUUID();
const apply = Boolean(args.apply);
const allowRemote = Boolean(args["allow-remote"]);
const databaseUrl = args["database-url"] || process.env.DATABASE_MIGRATION_URL;

if (!file || !eventKey || !Number.isInteger(actorId) || actorId < 0 || (apply && actorId === 0)) {
  usage();
  process.exit(2);
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
  console.error("--idempotency-key must be a UUID.");
  process.exit(2);
}

const payloadText = await readFile(file, "utf8");
const payload = JSON.parse(payloadText);
validatePayload(payload);
const payloadSha256 = createHash("sha256").update(payloadText, "utf8").digest("hex");

if (!apply) {
  console.log(JSON.stringify({
    mode: "dry-run",
    file,
    event_key: eventKey,
    actor_id: actorId,
    idempotency_key: idempotencyKey,
    bibs: payload.bibs.length,
    copies: payload.copies.length,
    payload_file_sha256: payloadSha256,
    database_writes: false,
  }, null, 2));
  process.exit(0);
}

if (!databaseUrl) {
  console.error("A local PostgreSQL URL is required in --database-url or DATABASE_MIGRATION_URL.");
  process.exit(2);
}
if (!allowRemote) {
  assertLocalHost(databaseUrl);
} else if (process.env.IUB_ALLOW_REMOTE_IMPORT !== "1") {
  console.error("Remote imports require IUB_ALLOW_REMOTE_IMPORT=1.");
  process.exit(2);
}

const client = new Client({
  connectionString: databaseUrl,
  application_name: "iub_event_inventory_import",
  statement_timeout: 120_000,
  query_timeout: 120_000,
});
await client.connect();
try {
  await client.query("SET statement_timeout = '120s'");
  await client.query("BEGIN");
  const result = await client.query(
    `SELECT import_id, status, bibs_inserted, copies_inserted, copies_reused, copies_skipped
       FROM public.import_event_inventory($1, $2::jsonb, $3, $4)`,
    [eventKey, payloadText, actorId, idempotencyKey],
  );
  await client.query("COMMIT");
  console.log(JSON.stringify({
    mode: "applied",
    event_key: eventKey,
    idempotency_key: idempotencyKey,
    payload_file_sha256: payloadSha256,
    result: result.rows[0],
  }, null, 2));
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error(JSON.stringify({
    mode: "failed",
    event_key: eventKey,
    idempotency_key: idempotencyKey,
    error: error.message,
    code: error.code,
    detail: error.detail,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await client.end();
}
