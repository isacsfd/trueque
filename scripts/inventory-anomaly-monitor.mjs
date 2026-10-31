#!/usr/bin/env node
import { URL } from "node:url";
import { Client } from "pg";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);

function usage() {
  console.error(`Usage:
  node scripts/inventory-anomaly-monitor.mjs [--database-url <url>] [--include-synthetic] [--json] [--allow-remote]

Read-only anomaly monitor. By default it reports only real inventory anomalies
and treats synthetic QA records separately. It refuses non-local database hosts
unless both --allow-remote and IUB_MONITOR_ALLOW_REMOTE=1 are supplied.`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (["include-synthetic", "json", "allow-remote", "help"].includes(key)) {
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

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}

const databaseUrl = args["database-url"] || process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) {
  console.error("A database URL is required in --database-url or DATABASE_ADMIN_URL.");
  process.exit(2);
}

const allowRemote = Boolean(args["allow-remote"]);
if (!allowRemote) {
  const host = new URL(databaseUrl).hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    console.error(`Refusing non-local database host '${host}'. Use --allow-remote and IUB_MONITOR_ALLOW_REMOTE=1 only for an approved read-only check.`);
    process.exit(2);
  }
} else if (process.env.IUB_MONITOR_ALLOW_REMOTE !== "1") {
  console.error("Remote monitoring requires IUB_MONITOR_ALLOW_REMOTE=1.");
  process.exit(2);
}

const includeSynthetic = Boolean(args["include-synthetic"]);
const client = new Client({
  connectionString: databaseUrl,
  application_name: "iub_inventory_anomaly_monitor",
  statement_timeout: 30_000,
  query_timeout: 30_000,
});

await client.connect();
try {
  await client.query("SET default_transaction_read_only = on");
  await client.query("BEGIN TRANSACTION READ ONLY");

  const anomalyView = includeSynthetic ? "public.inventory_anomalies" : "public.real_inventory_anomalies";
  const summary = await client.query(
    `SELECT jsonb_build_object(
       'catalog_count', (SELECT count(*) FROM public.available_catalog),
       'anomaly_counts', (
         SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'code', anomaly_code,
           'severity', severity,
           'synthetic', is_synthetic,
           'count', count
         ) ORDER BY severity, anomaly_code), '[]'::jsonb)
         FROM public.inventory_anomaly_counts
         WHERE ($1::boolean OR NOT is_synthetic)
       ),
       'anomalies', (
         SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'code', anomaly_code,
           'severity', severity,
           'copy_id', copy_id,
           'admission_id', admission_id,
           'exchange_id', exchange_id,
           'inventory_code', inventory_code,
           'synthetic', is_synthetic,
           'details', details
         ) ORDER BY severity, anomaly_code, copy_id), '[]'::jsonb)
         FROM ${anomalyView}
       ),
       'verification_backlog', (
         SELECT jsonb_build_object(
           'total', count(*),
           'overdue', count(*) FILTER (WHERE overdue)
         )
         FROM public.institutional_verification_backlog
       )
     ) AS summary`,
    [includeSynthetic],
  );

  await client.query("ROLLBACK");
  const data = summary.rows[0]?.summary;
  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`Catalog copies: ${data.catalog_count}`);
    console.log(`Real anomalies: ${data.anomalies.filter((item) => !item.synthetic).length}`);
    console.log(`Synthetic anomalies: ${data.anomalies.filter((item) => item.synthetic).length}`);
    console.log(`Verification backlog: ${data.verification_backlog.total} (overdue: ${data.verification_backlog.overdue})`);
    for (const item of data.anomalies) {
      console.log(`- [${item.severity}] ${item.code} copy=${item.copy_id ?? "-"} code=${item.inventory_code ?? "-"} synthetic=${item.synthetic}`);
    }
  }

  const realCritical = data.anomalies.some(
    (item) => !item.synthetic && ["critical", "high"].includes(item.severity),
  );
  if (realCritical) process.exitCode = 1;
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error(JSON.stringify({ error: error.message, code: error.code, detail: error.detail }, null, 2));
  process.exitCode = 1;
} finally {
  await client.end();
}
