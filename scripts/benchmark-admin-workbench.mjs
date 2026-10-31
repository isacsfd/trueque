import { performance } from "node:perf_hooks";
import { Client } from "pg";
import {
  workbenchCountQuery,
  workbenchQuery,
} from "../netlify/functions/admin-workbench.ts";

const connectionString = process.env.IUB_BENCH_DATABASE_URL;
if (!connectionString) {
  console.error("IUB_BENCH_DATABASE_URL is required.");
  process.exit(2);
}
const url = new URL(connectionString);
if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
  console.error("Benchmark refuses non-local databases.");
  process.exit(2);
}

const client = new Client({ connectionString, application_name: "iub_admin_benchmark" });
await client.connect();

async function measure(sql, params, runs = 9) {
  for (let index = 0; index < 2; index += 1) await client.query(sql, params);
  const times = [];
  let rows = [];
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    rows = (await client.query(sql, params)).rows;
    times.push(performance.now() - start);
  }
  times.sort((left, right) => left - right);
  return {
    median_ms: Number(times[Math.floor(times.length / 2)].toFixed(3)),
    p95_ms: Number(times[Math.floor(times.length * 0.95)].toFixed(3)),
    rows: rows.length,
    payload_bytes: Buffer.byteLength(JSON.stringify(rows), "utf8"),
  };
}

try {
  const before = await measure(workbenchQuery(false), [null, null, 100, 0]);
  const afterData = await measure(workbenchQuery(false), [null, null, 25, 0]);
  const afterLazyHistory = await measure(workbenchQuery(false, false, false), [null, null, 25, 0]);
  const afterSummary = await measure(workbenchQuery(false, true), [null, null, 25, 0]);
  const afterCount = await measure(workbenchCountQuery(), [null, null]);
  console.log(JSON.stringify({
    dataset: { requests: 10000, state_history_rows: 10000, offered_books: 10000 },
    before,
    after: {
      data: afterData,
      lazy_history: afterLazyHistory,
      summary: afterSummary,
      count: afterCount,
      total_median_ms: Number((afterData.median_ms + afterCount.median_ms).toFixed(3)),
      lazy_history_total_median_ms: Number((afterLazyHistory.median_ms + afterCount.median_ms).toFixed(3)),
      summary_total_median_ms: Number((afterSummary.median_ms + afterCount.median_ms).toFixed(3)),
    },
    methodology: "PostgreSQL 18 local, 2 warmups + 9 runs, median; data query payload measured as JSON bytes",
  }, null, 2));
} finally {
  await client.end();
}
