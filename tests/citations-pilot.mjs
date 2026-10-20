// Citations pilot rehearsal: Logic Solar Overland Park's BrightLocal campaign,
// in the sandbox. Run by `npm run test:citations-pilot` (scripts/test-tasks-ui.sh:
// throwaway Postgres + PostgREST capped at 1,000 rows, `next dev`, Chrome).
//
// Default: the committed SYNTHETIC campaign export (real column contract and
// status pattern, fictional business, FAKE credentials / token links in Notes).
// PILOT_CSV=<sanitized generic CSV outside the repo> PILOT_IDENTITY=<json>
// runs the same rehearsal on the real sanitized rows; nothing from that run is
// written into the repository (point SCREENSHOTS outside it too).
//
//   - The proposed identity is entered as a hidden-address location (sandbox
//     only; production identity awaits Tom's approval).
//   - Directory review: without creation, unknown directories are named and
//     rejected, Apple resolves by alias; with creation, the preview lists the
//     new directories and writes nothing.
//   - Commit: 11 listings, 9 provider complete + 2 submitted, all unverified, no
//     observation or check dates; the four historical attempts held, not listed.
//   - Repeat import adds nothing; no raw Notes content anywhere.
//   - The review queue: 9 verify tasks (linked listings), Yelp owner
//     verification, Apple and Bing investigations. Nothing marked corrected.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { parseCsv } from "../src/lib/citations.ts";

const { PGRST_URL, JWT_SECRET, PSQL_ADMIN, PILOT_CSV, PILOT_IDENTITY } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL_ADMIN, "run through scripts/test-tasks-ui.sh");
const REAL = !!PILOT_CSV;
const FILE = REAL ? PILOT_CSV : new URL("./fixtures/citations/synthetic-brightlocal-campaign.csv", import.meta.url).pathname;
const IDENTITY = REAL ? JSON.parse(readFileSync(PILOT_IDENTITY, "utf8")) : {
  label: "Sample Solar - Overland Park (synthetic)", business_name: "Sample Solar (synthetic)", address_line1: "1 Synthetic Plaza, Floor 7",
  city: "Overland Park", region: "KS", postal_code: "66210", phone: "555-010-0000", website_url: "https://sample-solar.example.test",
};
const SECRETS = ["Fake-Pass-0000", "SyntheticToken", "fake-owner", "FAKE0123456789abcdef", "synthetic.user@example.test"];
const NEW_DIRECTORIES = ["merchantcircle.com", "provenexpert.com", "brownbook.net", "tupalo.com", "callupcontact.com", "cybo.com", "trepup.com", "ezlocal.com", "us-info.com"];

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const CLIENT = "00000000-0000-4000-b000-00000000000a";
const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function sign(claims) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  return `${head}.${createHmac("sha256", JWT_SECRET).update(head).digest("base64url")}`;
}
function verify(token) {
  const [h, p, s] = (token ?? "").split(".");
  if (!s || createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url") !== s) return null;
  return JSON.parse(Buffer.from(p, "base64url").toString());
}
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const tokenFor = (u) => sign({ sub: u.id, role: "authenticated", aud: "authenticated", email: u.email, exp: exp() });
const sql = (q) => execFileSync("/bin/sh", ["-c", `${PSQL_ADMIN} -c "$Q"`], { env: { ...process.env, Q: q } }).toString().trim();

const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (url.pathname === "/auth/v1/user") {
    const claims = verify((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    const ok = claims?.sub === TEAM.id;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    return res.end(JSON.stringify(ok ? { ...TEAM, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } : { message: "invalid JWT" }));
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    const headers = {};
    for (const k of ["authorization", "content-type", "prefer", "accept", "range", "accept-profile", "content-profile"]) if (req.headers[k]) headers[k] = req.headers[k];
    const up = await fetch(`${PGRST_URL}${url.pathname.slice(8)}${url.search}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const h = {};
    for (const k of ["content-type", "content-range", "preference-applied", "location"]) { const v = up.headers.get(k); if (v) h[k] = v; }
    res.writeHead(up.status, h);
    return res.end(Buffer.from(await up.arrayBuffer()));
  }
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
const port = Number(process.env.CITATIONS_PILOT_PORT ?? 3439);
const base = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: gatewayUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: sign({ role: "anon", exp: exp() }), NEXT_TELEMETRY_DISABLED: "1", CITATIONS_ENABLED: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
app.stdout.on("data", (c) => { logs = (logs + c).slice(-12000); });
app.stderr.on("data", (c) => { logs = (logs + c).slice(-12000); });
const shots = process.env.SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✓ ${name}`); };
const count = async (page, key) => Number(await page.locator(`[data-count=${key}]`).first().innerText());
const counts = async (page) => Object.fromEntries(await Promise.all(["rows", "added", "updated", "skipped", "rejected", "held"].map(async (k) => [k, await count(page, k)])));
const noSecrets = (text, where) => { for (const s of SECRETS) assert.ok(!text.includes(s), `${where} carries no secret`); };
const table = (csv) => { const [head, ...rows] = parseCsv(csv); return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]]))); };
const held = REAL ? 0 : 4;
const total = REAL ? 11 : 15;

let browser;
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/login`)).status < 500) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const session = { access_token: tokenFor(TEAM), refresh_token: "local", expires_at: exp(), expires_in: 3600, token_type: "bearer", user: { ...TEAM, aud: "authenticated" } };
  await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64(session)}`, domain: "127.0.0.1", path: "/" }]);
  const team = await context.newPage();
  const errors = [];
  team.on("pageerror", (e) => errors.push(e.message));

  // ── The proposed identity, entered deliberately (sandbox) ─────────────
  await team.goto(`${base}/clients/${CLIENT}/citations`, { waitUntil: "networkidle" });
  await team.getByText("Add a business location").click();
  await team.getByRole("button", { name: "Start a location" }).click();
  for (const [label, key] of [["Location label", "label"], ["Approved business name", "business_name"], ["Street address", "address_line1"], ["City", "city"],
    ["State", "region"], ["ZIP", "postal_code"], ["Approved phone", "phone"], ["Approved website", "website_url"]]) await team.getByLabel(label, { exact: true }).fill(IDENTITY[key] ?? "");
  await team.getByLabel(/Hide the street address/).check();
  await team.getByLabel("Internal notes").fill("PROPOSED identity for the pilot rehearsal. Production identity and the hidden-address decision await Tom's approval.");
  await team.getByRole("button", { name: "Save approved identity" }).click();
  await team.getByRole("status").waitFor();
  const location = sql(`select id from citation_locations where label = '${IDENTITY.label.replaceAll("'", "''")}'`);
  assert.match(location, /^[0-9a-f-]{36}$/);
  ok("Identity: entered by hand as a hidden-address location (no clients.address auto-approval)");

  // ── Directory review, preview, commit ─────────────────────────────────
  async function load() {
    await team.goto(`${base}/clients/${CLIENT}/citations/import`, { waitUntil: "networkidle" });
    await team.locator("input[type=file]").setInputFiles(FILE);
    await team.getByText(/data rows, \d+ columns\./).waitFor();
    if (REAL) {
      assert.equal(await team.getByLabel("File format").inputValue(), "generic");
      await team.getByLabel("Where it came from").selectOption("brightlocal");
      await team.getByLabel(`Location for ${IDENTITY.csv_location ?? "Logic Solar - Overland Park"}`).selectOption(location);
    } else {
      await team.locator("[data-brightlocal-contract]").waitFor();
      assert.equal(await team.getByLabel("File format").inputValue(), "brightlocal_campaign", "the campaign export is recognized by its columns");
      await team.getByLabel("Campaign id").fill("900001");
      await team.getByLabel("Location for every row").selectOption(location);
    }
  }
  await load();
  noSecrets(await team.content(), "the loaded import page");
  await team.getByRole("button", { name: "Preview import" }).click();
  await team.locator("[data-import-preview]").waitFor();
  assert.deepEqual(await counts(team), { rows: total, added: 2, updated: 0, skipped: 0, rejected: 9, held }, "only Apple (alias) and Yelp are in the registry");
  const review = await team.locator("[data-import-preview]").innerText();
  for (const d of NEW_DIRECTORIES) assert.ok(review.includes(`Unknown directory "${d}"`), d);
  assert.ok(!/Unknown directory "maps\.apple\.com"/.test(review), "maps.apple.com resolves to Apple Business Connect");
  await shot(team, "pilot-directory-review");
  await team.getByLabel(/Add directories that are not in the registry/).check();
  await team.getByRole("button", { name: "Preview import" }).click();
  await team.locator("[data-new-directories]").waitFor();
  assert.deepEqual(await counts(team), { rows: total, added: 11, updated: 0, skipped: 0, rejected: 0, held });
  const listed = await team.locator("[data-new-directories]").innerText();
  for (const d of NEW_DIRECTORIES) assert.ok(listed.includes(d), d);
  assert.equal(sql(`select count(*) from citation_directories where domain in (${NEW_DIRECTORIES.map((d) => `'${d}'`).join(",")})`), "0", "the preview created nothing");
  if (!REAL) assert.match(await team.locator("[data-source-counts]").innerText(), /15 directory rows \(8 Live, 1 Updated, 2 Submitted, 1 Unavailable, 3 \(blank\)\), 1 footer row skipped, Notes excluded on 10 rows/);
  noSecrets(await team.content(), "the preview");
  await shot(team, "pilot-preview");
  await team.getByRole("button", { name: /^Import 11 rows/ }).click();
  await team.locator("[data-import-done]").waitFor();
  assert.deepEqual(await counts(team), { rows: total, added: 11, updated: 0, skipped: 0, rejected: 0, held });
  await shot(team, "pilot-import-done");
  ok(`Import: ${total} rows → 11 added${held ? `, ${held} held (manta / bing / all.biz / clutch)` : ""}; 9 new directories reviewed before creation; Apple matched by alias`);

  await team.getByRole("button", { name: "Import another file" }).click();
  await load();
  await team.getByLabel(/Add directories that are not in the registry/).check();
  await team.getByRole("button", { name: "Preview import" }).click();
  await team.locator("[data-import-preview]").waitFor();
  assert.deepEqual(await counts(team), { rows: total, added: 0, updated: 0, skipped: 11, rejected: 0, held });
  assert.equal(await team.locator("[data-new-directories]").count(), 0);
  ok("Repeat import: 0 added, 11 skipped, nothing new in the registry");

  // ── State after import ────────────────────────────────────────────────
  const state = sql(`select json_build_object('n', count(*), 'complete', count(*) filter (where fulfillment_status = 'provider_complete'),
      'submitted', count(*) filter (where fulfillment_status = 'submitted'), 'unverified', count(*) filter (where verification_status = 'unverified'),
      'checked', count(last_checked_on), 'observed', count(source_observed_on), 'nap', count(*) filter (where source_name || source_address || source_phone || source_website <> ''),
      'linked', count(listing_url), 'keys', count(distinct listing_key || directory_id::text)) from citation_listing_overview where location_id = '${location}'`);
  assert.deepEqual(JSON.parse(state), { n: 11, complete: 9, submitted: 2, unverified: 11, checked: 0, observed: 0, nap: 0, linked: 9, keys: 11 });
  noSecrets(sql(`select string_agg(notes, ' ') from citation_listings where location_id = '${location}'`) + sql(`select string_agg(message, ' ') from citation_import_rows`)
    + sql(`select string_agg(mapping::text, ' ') from citation_imports`), "the database");
  const heldRows = sql(`select coalesce(string_agg(message, ' | '), '') from citation_import_rows where outcome = 'held'`);
  if (!REAL) for (const d of ["manta.com", "bing.com", "all.biz", "clutch.co"]) assert.ok(heldRows.includes(`(${d})`), d);
  ok("State: 11 listings (9 provider complete, 2 submitted), all unverified, no check / observation dates, no NAP; held history kept on the import; no raw Notes");

  // ── Review queue (nothing corrected) ──────────────────────────────────
  const page = `${base}/clients/${CLIENT}/citations/${location}`;
  await team.goto(page, { waitUntil: "networkidle" });
  await team.getByRole("button", { name: "Queue verification for linked listings" }).click();
  await team.locator("[data-queued]").waitFor();
  assert.equal(await team.locator("[data-queued]").getAttribute("data-queued"), "9");
  await team.getByRole("button", { name: "Queue verification for linked listings" }).click();
  await team.getByText("Nothing new to queue.").waitFor();
  async function openTask(kind, listing, reason) {
    const form = team.locator("section").filter({ has: team.getByRole("heading", { name: "Listings" }) }).first();
    const again = form.getByRole("button", { name: /^Open (another|a) task$/ }).first();
    await again.click();
    await form.locator("select[name=kind]").first().selectOption(kind);
    await form.locator("select[name=listing_id]").first().selectOption({ label: listing });
    await form.locator("textarea[name=reason]").first().fill(reason);
    await form.getByRole("button", { name: "Open task", exact: true }).first().click();
    await form.getByRole("button", { name: "Open another task" }).first().waitFor();
  }
  await openTask("verify", "Yelp", "Yelp owner verification: BrightLocal flags the listing as ready for personal and phone verification by the owner. No public URL yet. Do not mark done without evidence of a claimed, verified listing.");
  await openTask("investigate", "Apple Business Connect", "Apple: provider status Submitted with no public URL. Find the current Apple Maps listing and who controls it (Business Connect) before any change.");
  await openTask("investigate", "The location (no listing yet)", "Bing: the provider could not submit (historical technical issue). Check whether a Bing Places listing exists and who owns it before creating anything. Not proof of absence.");
  await team.reload({ waitUntil: "networkidle" });
  const tasks = JSON.parse(sql(`select json_build_object('open', count(*) filter (where status = 'open'), 'verify', count(*) filter (where kind = 'verify'),
    'investigate', count(*) filter (where kind = 'investigate'), 'resolved', count(*) filter (where status in ('resolved', 'cancelled'))) from citation_tasks where location_id = '${location}'`));
  assert.deepEqual(tasks, { open: 12, verify: 10, investigate: 2, resolved: 0 });
  assert.equal(sql(`select count(*) from citation_listing_overview where location_id = '${location}' and verification_status <> 'unverified'`), "0", "nothing marked verified or corrected");
  await shot(team, "pilot-queue");
  ok("Queue: 9 verify (linked listings), Yelp owner verification, Apple and Bing investigations; repeat queue adds 0; nothing resolved");

  // ── Reports ───────────────────────────────────────────────────────────
  const client = table(await (await context.request.get(`${base}/clients/${CLIENT}/citations/export?variant=client&location=${location}`)).text());
  assert.equal(client.length, 11);
  assert.ok(client.every((r) => r["Verification"] === "Unverified" && r["Evidence"] === "Never checked" && r["Last checked"] === "" && r["Source observed"] === ""));
  assert.ok(client.every((r) => !r["Approved address"].includes(IDENTITY.address_line1.split(",")[0])), "client-safe export withholds the street");
  ok("Export: 11 rows, all unverified / never checked, no observation date, street withheld in the client-safe file");

  const summary = { mode: REAL ? "real sanitized rows (outside the repo)" : "synthetic", location, state: JSON.parse(state), tasks };
  if (shots) writeFileSync(`${shots}/pilot-summary.json`, JSON.stringify(summary, null, 2));
  assert.deepEqual(errors, []);
  console.log(`citations pilot (${summary.mode}): ${checks.length} checks passed`);
} catch (e) {
  console.error(logs);
  throw e;
} finally {
  await browser?.close();
  app.kill();
  gateway.close();
}
process.exit(0);
