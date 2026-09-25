#!/usr/bin/env node
// Authority Engine v1 dry run. Read-only: reads the loader output
// (scripts/authority-input.sql) and a site inventory (scripts/site-inventory.mjs),
// runs the deterministic engine and writes JSON and Markdown. No model, no
// database, no network.
//
//   node --no-warnings scripts/authority-dry-run.mjs --input authority-input.json \
//     --inventory inventory.json [--out-json authority.json] [--out-md authority.md] [--now 2026-09-25T18:00:00Z]
import fs from "node:fs";
import { runAuthority } from "../supabase/functions/authority/engine.ts";
import { renderMarkdown } from "../supabase/functions/authority/report.ts";

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const die = (m) => { console.error(m); process.exit(2); };

let input = JSON.parse(fs.readFileSync(arg("input") ?? die("--input is required"), "utf8"));
if (Array.isArray(input)) input = input[0];
if (input?.input) input = input.input;
if (!input?.authority) die("The input has no authority section: run scripts/authority-input.sql.");
if (arg("inventory")) input.authority.inventory = JSON.parse(fs.readFileSync(arg("inventory"), "utf8"));
if (arg("now")) input.authority.now = arg("now");
if (!input.authority.places) {
  const gaz = JSON.parse(fs.readFileSync(new URL("../supabase/functions/post-drafter/gazetteer.json", import.meta.url), "utf8"));
  input.authority.places = gaz[input.client.state] ?? [];
}

const report = runAuthority(input);
const md = renderMarkdown(report);
if (arg("out-json")) fs.writeFileSync(arg("out-json"), JSON.stringify(report, null, 2));
if (arg("out-md")) fs.writeFileSync(arg("out-md"), md);
if (!arg("out-json") && !arg("out-md")) console.log(md);
console.error(`${report.pillars.length} pillars, ${report.keywords.length} keywords, ${report.conflicts.length} conflicts, ${report.opportunities.length} opportunities (${report.opportunities.filter((o) => o.tier !== "none").length} ranked).`);
