#!/usr/bin/env node
// Site-program readiness receipt (Gate B / Gate C). Read-only: it calls the
// STABLE site_program_readiness() through PostgREST as a signed-in teammate
// (PostgREST runs a STABLE function in a read-only transaction), or renders a
// report saved earlier. It writes nothing anywhere except --json.
//
//   SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_ACCESS_TOKEN=<teammate JWT> \
//     node --no-warnings scripts/site-program-readiness.mjs <client-id> [--json out.json]
//   node --no-warnings scripts/site-program-readiness.mjs --file report.json
import fs from "node:fs";
import { renderReadiness } from "../src/lib/site-program-readiness.ts";

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const die = (m) => { console.error(m); process.exit(2); };

let report;
if (arg("file")) {
  report = JSON.parse(fs.readFileSync(arg("file"), "utf8"));
  // Accept the bare report, [{site_program_readiness: …}] (an SQL export) or {site_program_readiness: …}.
  if (Array.isArray(report)) report = report[0];
  if (report?.site_program_readiness) report = report.site_program_readiness;
} else {
  const client = args.find((a) => /^[0-9a-f-]{36}$/i.test(a)) ?? die("Give a client id, or --file report.json.");
  const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_ACCESS_TOKEN: token } = process.env;
  if (!url || !anon || !token) die("Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_ACCESS_TOKEN (a signed-in teammate's JWT).");
  const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/site_program_readiness`, {
    method: "POST",
    headers: { apikey: anon, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ p_client_id: client }),
  });
  if (!res.ok) die(`site_program_readiness answered ${res.status}: ${await res.text()}`);
  report = await res.json();
}
if (!report?.programs) die("Not a site_program_readiness report.");
if (arg("json")) fs.writeFileSync(arg("json"), JSON.stringify(report, null, 2));
console.log(renderReadiness(report));
