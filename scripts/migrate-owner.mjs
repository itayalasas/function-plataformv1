import { neon } from "@neondatabase/serverless";
const s = neon(process.env.NEON_DATABASE_URL);
const OLD = "349c48ac-c062-41d5-9288-86855470bfb7";
const NEW = "294e2374-7b98-476d-99ee-b4c81f8ec95c";
const tables = ["projects","functions","function_files","secrets","function_tokens","deployments","invocation_logs","system_logs"];
for (const t of tables) {
  await s.query(`UPDATE ${t} SET owner_id = $1 WHERE owner_id = $2`, [NEW, OLD]);
  console.log(t, "ok");
}
const check = await s`SELECT owner_id, COUNT(*)::int AS n FROM projects GROUP BY owner_id`;
console.log("projects:", JSON.stringify(check));
