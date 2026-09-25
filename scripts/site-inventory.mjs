#!/usr/bin/env node
// Read-only snapshot of a client's public site for the Authority Engine.
// The logic lives in supabase/functions/authority/inventory.ts (shared with
// the authority-run Edge Function): GETs the sitemap and the URLs the CRM
// records, only on the site's own host, follows redirects by hand so a loop
// is detected, and keeps title, H1, H2s, canonical, word count and text.
// Writes only the output file.
//
//   node --no-warnings scripts/site-inventory.mjs --site https://example.com \
//     [--input authority-input.json]   # adds page groups, service pages, keyword targets, GSC pages, proposals
//     [--urls /a,/b] [--out inventory.json] [--max 150]
import fs from "node:fs";
import { inventorySite, candidatesFrom } from "../supabase/functions/authority/inventory.ts";

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const site = (arg("site") ?? "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(site)) { console.error("--site https://… is required"); process.exit(2); }

const candidates = (arg("urls") ?? "").split(",").filter(Boolean);
if (arg("input")) {
  let input = JSON.parse(fs.readFileSync(arg("input"), "utf8"));
  if (Array.isArray(input)) input = input[0];
  if (input?.input) input = input.input;
  candidates.push(...candidatesFrom(input));
}
const out = await inventorySite({ site, candidates, maxPages: Number(arg("max", "150")) });
const dest = arg("out");
if (dest) fs.writeFileSync(dest, JSON.stringify(out, null, 2)); else console.log(JSON.stringify(out, null, 2));
console.error(`${out.pages.length} URLs (${out.sitemap_urls} in the sitemap); ${out.pages.filter((p) => p.redirect_loop).length} loops, ${out.pages.filter((p) => p.final_status === 404).length} 404s, ${out.refused.length} refused.`);
