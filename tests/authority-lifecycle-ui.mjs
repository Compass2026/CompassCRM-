// Browser acceptance check for the Authority lifecycle actions (Accept,
// Release, Dismiss for 30 / 60 / 90 days, Never recommend again, Reopen) on
// the Authority tab. Run by `npm run test:authority-lifecycle-ui`
// (scripts/test-tasks-ui.sh with UI_SPEC set): a real Postgres replay behind
// PostgREST, `next dev` and Chromium. The server action calls 0048's
// authority_decide as the signed-in teammate, exactly as in production. The
// Lucas run is the trimmed production export, recorded through the service
// path authority-run uses. Nothing leaves the machine.
//
//   SCREENSHOTS=docs/screenshots/authority npm run test:authority-lifecycle-ui
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const { PGRST_URL, JWT_SECRET, PSQL } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL, "run through scripts/test-tasks-ui.sh");
const SHOTS = process.env.SCREENSHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const PORTAL = { id: "00000000-0000-4000-a000-000000000011", email: "portal-a@example.test" };
const users = new Map([TEAM, PORTAL].map((u) => [u.id, u]));

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
const anonKey = sign({ role: "anon", exp: exp() });
const tokenFor = (u) => sign({ sub: u.id, role: "authenticated", aud: "authenticated", email: u.email, exp: exp() });


// Supabase's gateway, reduced to what the app calls: /auth/v1/user and /rest/v1.
const unexpected = [];
const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (url.pathname === "/auth/v1/user") {
    const claims = verify(bearer);
    const u = claims?.sub && users.get(claims.sub);
    res.writeHead(u ? 200 : 401, { "content-type": "application/json" });
    return res.end(JSON.stringify(u ? { ...u, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } : { message: "invalid JWT" }));
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    const body = [];
    for await (const c of req) body.push(c);
    const headers = {};
    for (const k of ["authorization", "content-type", "prefer", "accept", "range", "accept-profile", "content-profile"]) {
      if (req.headers[k]) headers[k] = req.headers[k];
    }
    const upstream = await fetch(`${PGRST_URL}${url.pathname.slice(8)}${url.search}`, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(body),
    });
    const out = Buffer.from(await upstream.arrayBuffer());
    const h = {};
    for (const k of ["content-type", "content-range", "preference-applied", "location"]) {
      const v = upstream.headers.get(k);
      if (v) h[k] = v;
    }
    res.writeHead(upstream.status, h);
    return res.end(out);
  }
  unexpected.push(`${req.method} ${url.pathname}`);
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;

const port = Number(process.env.AUTHORITY_UI_PORT ?? 3423);
const base = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: gatewayUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
app.stdout.on("data", (c) => { logs = (logs + c).slice(-8000); });
app.stderr.on("data", (c) => { logs = (logs + c).slice(-8000); });

async function contextFor(browser, user, viewport) {
  const context = await browser.newContext({ viewport });
  const session = { access_token: tokenFor(user), refresh_token: "local", expires_at: exp(), expires_in: 3600, token_type: "bearer", user: { ...user, aud: "authenticated" } };
  await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64(session)}`, domain: "127.0.0.1", path: "/" }]);
  return context;
}

// Elements that stick out past the viewport; empty means no horizontal scroll.
const overflowing = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .filter((el) => !el.closest(".overflow-x-auto"))
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 3).join(".")} → ${Math.round(el.getBoundingClientRect().right)}px`)
  );
const noHorizontalScroll = async (page) => {
  const out = await overflowing(page);
  if (out.length) console.log("    overflow:", out.join(" | "));
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
};

const FX = JSON.parse(readFileSync(new URL("./fixtures/authority-lucas-run.json", import.meta.url), "utf8"));
const LUCAS = FX.meta.client.id;
const serviceKey = sign({ role: "service_role", exp: exp() });
const asService = { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" };
const rpc = async (fn, args) => {
  const r = await fetch(`${PGRST_URL}/rpc/${fn}`, { method: "POST", headers: asService, body: JSON.stringify(args) });
  const body = await r.json().catch(() => null);
  assert.ok(r.ok, `${fn}: ${r.status} ${JSON.stringify(body)}`);
  return body;
};
// The recorded observation: 62 pages answering 200 and 2 answering 404, as in production.
const inventory = (fetchedAt, health = { status: "completed", reasons: [], inventory_errors: 0 }) => ({
  fetched_at: fetchedAt, site: "https://lucasconstructionmo.com", sitemap_urls: 47, refused: [], refusals: [], budget_exceeded: false, skipped: 0, health,
  pages: Array.from({ length: 64 }, (_, i) => ({ url: `https://lucasconstructionmo.com/p${i}`, status: i < 62 ? 200 : 404, final_url: null, final_status: i < 62 ? 200 : 404,
    redirect_loop: false, in_sitemap: true, title: null, h1: null, h2: [], canonical: null, words: null, text: null })),
});
const report = () => ({
  version: "authority-v1.1", client: FX.meta.client, as_of: FX.meta.as_of, generated_at: FX.meta.generated_at, inventory: FX.meta.inventory,
  sources: FX.meta.sources, pillars: FX.meta.pillars, keywords: [], conflicts: [], supporting: [], opportunities: FX.opportunities, judgments: [],
});
async function recordRun({ mode, via, by = null, status = "completed", fetchedAt = FX.meta.run.inventory_fetched_at, error = null, health }) {
  const runId = await rpc("authority_begin_run", { p_client_id: LUCAS, p_mode: mode, p_requested_via: via, p_requested_by: by });
  if (status === "running") return runId;
  if (status === "failed") { await rpc("authority_record_run", { p_run_id: runId, p: { status, error } }); return runId; }
  const fingerprint = await rpc("authority_fingerprint", { p_client_id: LUCAS });
  const inv = inventory(fetchedAt, health);
  await rpc("authority_record_run", { p_run_id: runId, p: {
    status, engine_version: "authority-v1.1", judged_at: FX.meta.generated_at, as_of: FX.meta.as_of,
    input_hash: `sha256:${"a".repeat(64)}`, section_hashes: fingerprint, inventory: inv, inventory_errors: health?.inventory_errors ?? 0, report: report(),
  } });
  return runId;
}


const ROOF_REPAIR = "service_page:c1c55a67-bc9f-43d1-a3a6-ad9bfe96841d";
const ROOF_REPLACE = "page_improvement:4288b96c-db9f-436e-b492-78f5fa7f1f21";
const HOME = "page_improvement:home";
const RESEARCH = "topic:storm_hail";
const SERVICE = "confirm_service:/services/commercial-roofing";
const OWNERSHIP = "data_fix:keyword-ownership:4288b96c-db9f-436e-b492-78f5fa7f1f21";

// Today on the agency's calendar, plus N days (what the dialog and the database must agree on).
const chicagoToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const plusDays = (n) => { const d = new Date(`${chicagoToday()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmtDay = (day) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${day}T12:00:00Z`));

let browser;
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };
const sql = (q) => execFileSync("/bin/sh", ["-c", `${PSQL} -c "$Q"`], { env: { ...process.env, Q: q } }).toString().trim();
const row = (key) => {
  const out = sql(`select row_to_json(o) from (select status, suppressed, dismissed_until, status_reason from authority_opportunities where client_id = '${LUCAS}' and key = '${key}') o`);
  return out ? JSON.parse(out) : null;
};
const events = (key, kind) => Number(sql(`select count(*) from authority_opportunity_events e join authority_opportunities o on o.id = e.opportunity_id where o.client_id = '${LUCAS}' and o.key = '${key}' and e.kind = '${kind}'`));
const oppId = (key) => sql(`select id from authority_opportunities where client_id = '${LUCAS}' and key = '${key}'`);
try {
  sql(`insert into clients (id, name, city, state, phone, website_url, business_type, status)
       values ('${LUCAS}', 'Lucas Construction', 'Wentzville', 'MO', '(636) 555-0100', 'https://lucasconstructionmo.com', 'service_area', 'active')`);
  const sam = sql(`select id from team_members where email = '${TEAM.email}'`);
  await recordRun({ mode: "full", via: "team", by: sam });
  await recordRun({ mode: "refresh", via: "worker" });

  for (let i = 0; i < 120; i++) {
    if (app.exitCode !== null) throw new Error(`next dev stopped:\n${logs}`);
    try { await fetch(`${base}/login`); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  const executablePath = process.env.CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] } : { channel: process.env.CHROME_CHANNEL ?? "chrome" }) });
  const ctx = await contextFor(browser, TEAM, { width: 1280, height: 900 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const shot = async (name, p = page, fullPage = true) => {
    if (!SHOTS) return;
    await p.waitForTimeout(600);
    await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
  };
  const url = `${base}/clients/${LUCAS}/authority`;
  const card = (key, p = page) => p.locator(`article[data-key="${key}"]`);
  const summaryCount = async (s, p = page) => Number(await p.locator(`[data-summary="${s}"] [data-count]`).innerText());
  const waitMsg = async (key, re, p = page) => {
    await p.waitForFunction(([k, src]) => new RegExp(src).test(document.querySelector(`article[data-key="${k}"] [data-lifecycle-message]`)?.textContent ?? ""), [key, re.source], { timeout: 15000 })
      .catch(async (e) => { throw new Error(`${e.message}\n  ${key}: ${JSON.stringify(await card(key, p).locator("[data-lifecycle-message]").innerText().catch(() => null))}`); });
  };
  const openMenu = async (key, p = page) => {
    await card(key, p).locator('[data-menu="lifecycle"]').click();
    await p.locator('[data-slot="dropdown-menu-item"]').first().waitFor();
  };
  const chooseItem = async (key, item, p = page) => {
    await openMenu(key, p);
    await p.locator(`[data-item="${item}"]`).click();
  };
  const inDismissed = (key, p = page) => p.locator(`#section-dismissed article[data-key="${key}"]`);
  const dismissedCount = async (p = page) => ((await p.locator("#dismissed").count()) ? Number(await p.locator("#dismissed > summary [data-count]").innerText()) : 0);

  // 1. Every open card offers Accept and a lifecycle menu; nothing is decided yet.
  await page.goto(url, { waitUntil: "networkidle" });
  await card(ROOF_REPAIR).waitFor();
  assert.equal(await card(ROOF_REPAIR).locator('[data-verb="accept"]').innerText(), "Accept");
  await openMenu(ROOF_REPAIR);
  assert.deepEqual(await page.locator('[data-slot="dropdown-menu-item"]').evaluateAll((els) => els.map((e) => e.dataset.item)),
    ["dismiss-30", "dismiss-60", "dismiss-90", "suppress"]);
  await shot("authority-lifecycle-menu-desktop", page, false);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#section-dismissed").count(), 0, "no Dismissed group while nothing is dismissed");
  assert.equal(await page.getByRole("button", { name: /Approve market|Confirm service|Set service page|Create task/ }).count(), 0, "no decision or reconciliation actions in PR A");
  ok("Open cards: Accept plus a menu of Dismiss 30 / 60 / 90 and Never recommend again; no Dismissed group, no decision or CRM actions");

  // 2. Accept (double-clicked) → one event; Release.
  await card(ROOF_REPAIR).locator('[data-verb="accept"]').dblclick();
  await waitMsg(ROOF_REPAIR, /Accepted\./);
  await card(ROOF_REPAIR).locator('[data-status="accepted"]').waitFor();
  assert.equal(row(ROOF_REPAIR).status, "accepted");
  assert.equal(events(ROOF_REPAIR, "accepted"), 1, "a double click accepts once");
  assert.equal(await card(ROOF_REPAIR).locator('[data-verb="accept"]').count(), 0);
  await chooseItem(ROOF_REPAIR, "release");
  await waitMsg(ROOF_REPAIR, /Released/);
  await card(ROOF_REPAIR).locator('[data-verb="accept"]').waitFor();
  assert.equal(row(ROOF_REPAIR).status, "open");
  assert.equal(events(ROOF_REPAIR, "released"), 1);
  ok("Accept (double-clicked: one accepted event) shows the Accepted chip; Release returns it to open");

  // 3. A second tab acting on a state it did not see.
  const other = await ctx.newPage();
  await other.goto(url, { waitUntil: "networkidle" });
  await card(ROOF_REPLACE).locator('[data-verb="accept"]').click();
  await waitMsg(ROOF_REPLACE, /Accepted\./);
  await card(ROOF_REPLACE, other).locator('[data-verb="accept"]').click();
  await waitMsg(ROOF_REPLACE, /changed since the page loaded/, other);
  await card(ROOF_REPLACE, other).locator('[data-status="accepted"]').waitFor();
  assert.equal(events(ROOF_REPLACE, "accepted"), 1, "the second tab's accept recorded nothing");
  await other.close();
  ok("Duplicate from a second tab: 'changed since the page loaded', no second event, and that tab now shows Accepted");

  // 4. Dismiss for 30 days: reason required, the end date shown, moved to the collapsed Dismissed group.
  const fixBefore = await summaryCount("fix_now");
  await chooseItem(ROOF_REPAIR, "dismiss-30");
  const dlg = page.locator('[data-dialog="dismiss-30"]');
  await dlg.waitFor();
  assert.equal(await dlg.locator("[data-until]").getAttribute("data-until"), plusDays(30));
  assert.ok((await dlg.innerText()).includes(fmtDay(plusDays(30))));
  assert.ok(await dlg.locator("[data-confirm]").isDisabled(), "no reason, no dismissal");
  await dlg.locator("[data-reason-input]").fill("   ");
  assert.ok(await dlg.locator("[data-confirm]").isDisabled(), "a blank reason is not a reason");
  await dlg.locator("[data-reason-input]").fill("After the photo shoot");
  await shot("authority-lifecycle-dismiss-dialog-desktop", page, false);
  await dlg.locator("[data-confirm]").click();
  await inDismissed(ROOF_REPAIR).waitFor({ state: "attached" });
  assert.deepEqual(row(ROOF_REPAIR), { status: "dismissed", suppressed: false, dismissed_until: plusDays(30), status_reason: "After the photo shoot" });
  assert.equal(await summaryCount("fix_now"), fixBefore - 1);
  assert.equal(await page.locator("#dismissed").evaluate((d) => d.open), false, "the Dismissed group starts collapsed");
  assert.equal(await dismissedCount(), 1);
  assert.equal(await card(ROOF_REPAIR).count(), 1, "shown once, in the Dismissed group only");
  ok(`Dismiss 30 days: reason required (blank refused), dialog and database agree on ${plusDays(30)}; the card leaves Fix Now (${fixBefore} → ${fixBefore - 1}) for the collapsed Dismissed group`);

  // 5. 60 and 90 days.
  for (const [key, days, why] of [[HOME, 60, "Budget next quarter"], [RESEARCH, 90, "Seasonal: spring"]]) {
    if (key === RESEARCH) await page.locator("#research-first").evaluate((d) => { d.open = true; });
    await chooseItem(key, `dismiss-${days}`);
    const d = page.locator(`[data-dialog="dismiss-${days}"]`);
    await d.locator("[data-reason-input]").fill(why);
    assert.equal(await d.locator("[data-until]").getAttribute("data-until"), plusDays(days));
    await d.locator("[data-confirm]").click();
    await inDismissed(key).waitFor({ state: "attached" });
    assert.equal(row(key).dismissed_until, plusDays(days));
  }
  assert.equal(await dismissedCount(), 3);
  ok(`Dismiss 60 / 90 days: stored as ${plusDays(60)} / ${plusDays(90)}; three items in the Dismissed group`);

  // 6. Never recommend again: reason and an explicit acknowledgement.
  await chooseItem(SERVICE, "suppress");
  const sup = page.locator('[data-dialog="suppress"]');
  await sup.waitFor();
  assert.match(await sup.innerText(), /will not be recommended again, whatever later analyses find, until someone reopens it/);
  await sup.locator("[data-reason-input]").fill("They don't do commercial work");
  assert.ok(await sup.locator("[data-confirm]").isDisabled(), "the acknowledgement is required");
  await sup.locator("[data-permanent]").check();
  await shot("authority-lifecycle-suppress-dialog-desktop", page, false);
  await sup.locator("[data-confirm]").click();
  await inDismissed(SERVICE).waitFor({ state: "attached" });
  assert.deepEqual(row(SERVICE), { status: "dismissed", suppressed: true, dismissed_until: null, status_reason: "They don't do commercial work" });
  ok("Never recommend again: reason plus 'permanent until reopened' acknowledgement; stored suppressed with no date");

  // 7. The Dismissed group: chips, reasons, history.
  await page.locator("#dismissed > summary").click();
  const dsm = page.locator("#section-dismissed");
  assert.equal(await dsm.locator(`article[data-key="${ROOF_REPAIR}"] [data-status]`).innerText(), `Dismissed until ${fmtDay(plusDays(30))}`);
  assert.equal(await dsm.locator(`article[data-key="${SERVICE}"] [data-status]`).innerText(), "Never recommend");
  assert.match(await dsm.locator(`article[data-key="${SERVICE}"] [data-dismiss-reason]`).innerText(), /They don't do commercial work.*Sam Team/);
  await dsm.locator(`article[data-key="${ROOF_REPAIR}"] details > summary`, { hasText: "Details" }).click();
  const hist = await dsm.locator(`article[data-key="${ROOF_REPAIR}"] [data-event]`).evaluateAll((els) => els.map((e) => e.textContent));
  assert.deepEqual(hist.map((t) => t.replace(/^[^·]*· /, "")), [
    "First reported · engine", "Accepted · Sam Team", "Released · Sam Team", `Dismissed until ${fmtDay(plusDays(30))} — “After the photo shoot” · Sam Team`,
  ]);
  await shot("authority-lifecycle-dismissed-desktop");
  ok("Dismissed group: dated and never-recommend chips, the reason with who decided, and the history in Details (first reported, accepted, released, dismissed with reason and date)");

  // 8. Suppression and dates survive later analyses.
  await recordRun({ mode: "refresh", via: "worker" });
  await page.goto(url, { waitUntil: "networkidle" });
  for (const k of [ROOF_REPAIR, HOME, RESEARCH, SERVICE]) assert.equal(await inDismissed(k).count(), 1, `${k} still dismissed after a new run`);
  assert.equal(row(SERVICE).suppressed, true);
  ok("A new completed run: all four stay dismissed; never-recommend persists");

  // 9. Reopen from the Dismissed group.
  await page.locator("#dismissed > summary").click();
  await inDismissed(SERVICE).locator('[data-verb="reopen"]').click();
  await card(SERVICE).locator('[data-verb="accept"]').waitFor();
  assert.deepEqual(row(SERVICE), { status: "open", suppressed: false, dismissed_until: null, status_reason: null });
  assert.equal(await inDismissed(SERVICE).count(), 0);
  assert.equal(await dismissedCount(), 3);
  ok("Reopen: never-recommend lifted, back in Needs Decision with Accept; the Dismissed group shrinks to 3");

  // 10. Linked open work: the menu says why, and the database refuses a stale dialog.
  assert.equal(row(ROOF_REPLACE).status, "accepted", "accepted in step 3");
  await chooseItem(ROOF_REPLACE, "dismiss-30"); // dialog opened on the page's (accepted, no work) state …
  const stale = page.locator('[data-dialog="dismiss-30"]');
  await stale.locator("[data-reason-input]").fill("x");
  const task = sql(`insert into tasks (client_id, title) values ('${LUCAS}', 'Rewrite the Roof Replacement page') returning id`).split("\n")[0];
  await rpc("authority_decide", { p_opportunity_id: oppId(ROOF_REPLACE), p_verb: "link", p_payload: { kind: "task", id: task } }); // … then work is linked (as the Drafter path would)
  await stale.locator("[data-confirm]").click();
  await page.waitForFunction(() => /Work is linked/.test(document.querySelector('[data-dialog="dismiss-30"] [role="alert"]')?.textContent ?? ""));
  assert.equal(row(ROOF_REPLACE).status, "accepted", "not dismissed");
  await stale.getByRole("button", { name: "Cancel" }).click();
  await page.goto(url, { waitUntil: "networkidle" });
  assert.equal(await card(ROOF_REPLACE).locator("[data-status]").innerText(), "In progress");
  assert.match(await card(ROOF_REPLACE).locator("[data-disabled-reason]").innerText(), /Work is linked and still open/);
  await openMenu(ROOF_REPLACE);
  assert.ok(await page.locator('[data-item="dismiss-30"]').evaluate((e) => e.hasAttribute("data-disabled")));
  await page.keyboard.press("Escape");
  ok("Linked work: a dialog opened before the task was linked is refused by authority_decide ('Work is linked…', nothing changed); after reload the card reads In progress and the dismissals are disabled with the reason");

  // 11. Mobile.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url, { waitUntil: "networkidle" });
  assert.ok(await noHorizontalScroll(page), "no horizontal scroll at 390px");
  await shot("authority-lifecycle-mobile");
  await chooseItem(OWNERSHIP, "suppress");
  await page.locator('[data-dialog="suppress"]').waitFor();
  assert.ok(await page.locator('[data-dialog="suppress"]').evaluate((d) => d.getBoundingClientRect().right <= window.innerWidth + 1));
  await shot("authority-lifecycle-dialog-mobile", page, false);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 900 });
  ok("Mobile (390px): no horizontal scroll; the menu and the never-recommend dialog fit the screen");

  // 12. Portal contact and offboarded client.
  const asPortal = { apikey: anonKey, authorization: `Bearer ${tokenFor(PORTAL)}`, "content-type": "application/json" };
  const r = await fetch(`${gatewayUrl}/rest/v1/rpc/authority_decide`, { method: "POST", headers: asPortal, body: JSON.stringify({ p_opportunity_id: oppId(HOME), p_verb: "reopen", p_payload: {} }) });
  assert.ok(r.status === 403 || r.status === 401, `portal decide refused (${r.status})`);
  assert.equal(row(HOME).status, "dismissed");
  const portalCtx = await contextFor(browser, PORTAL, { width: 1280, height: 900 });
  const portalPage = await portalCtx.newPage();
  await portalPage.goto(url, { waitUntil: "networkidle" });
  assert.ok(!portalPage.url().includes("/authority"), `portal user was not left on the Authority page (${portalPage.url()})`);
  sql(`update clients set status = 'offboarded' where id = '${LUCAS}'`);
  await page.goto(url, { waitUntil: "networkidle" });
  assert.equal(await page.locator("[data-lifecycle]").count(), 0, "no lifecycle actions for an offboarded client");
  assert.ok(await card(ROOF_REPLACE).isVisible(), "the work queue is still readable");
  ok("Portal contact: authority_decide refused through the API and redirected away from the tab; an offboarded client shows no lifecycle actions");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(`Authority lifecycle browser checks passed (${checks.length}).${SHOTS ? ` Screenshots in ${SHOTS}.` : ""}`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
