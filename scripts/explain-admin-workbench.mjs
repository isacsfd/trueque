import { Client } from "pg";
import { workbenchQuery } from "../netlify/functions/admin-workbench.ts";

const client = new Client({ connectionString: process.env.IUB_BENCH_DATABASE_URL });
await client.connect();
try {
  const sql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${workbenchQuery(false, false, false)}`;
  const result = await client.query(sql, [null, null, 25, 0]);
  const plan = result.rows[0]["QUERY PLAN"][0];
  console.log(JSON.stringify({
    execution_ms: plan["Execution Time"],
    planning_ms: plan["Planning Time"],
    top: plan.Plan,
  }, null, 2).slice(0, 12000));
} finally {
  await client.end();
}
