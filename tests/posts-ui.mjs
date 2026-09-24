// Browser acceptance check for the post review gate (0045). Run by
// `npm run test:posts-ui` (scripts/test-tasks-ui.sh with UI_SPEC set), which
// provides a real Postgres replay behind PostgREST (PGRST_URL, JWT_SECRET)
// and a psql command (PSQL, connected as postgres — the worker's login).
// PostgREST connects as authenticator, so everything the browser does
// reaches the triggers exactly as a signed-in teammate does in production.
// Fictional data only; nothing leaves the machine.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const { PGRST_URL, JWT_SECRET, PSQL } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL, "run through scripts/test-tasks-ui.sh");
const SHOTS = process.env.SCREENSHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const PORTAL = { id: "00000000-0000-4000-a000-000000000011", email: "portal-a@example.test" };
const CLIENT_A = "00000000-0000-4000-b000-00000000000a";
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

const sql = (q) => execFileSync("/bin/sh", ["-c", `${PSQL} -c "$Q"`], { env: { ...process.env, Q: q } }).toString().trim();

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

const port = Number(process.env.POSTS_UI_PORT ?? 3419);
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

let browser;
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };
const sqlFails = (q) => {
  try { sql(q); return null; } catch (e) { return String(e.stderr ?? e.message); }
};
const POST_A = "00000000-0000-4000-f300-00000000000a"; // worker draft, commercial, no claim yet
const POST_OFFER = "00000000-0000-4000-f300-00000000001a"; // worker offer post, in review
const POST_FB = "00000000-0000-4000-f300-00000000002a"; // worker Facebook post, in review
try {
  for (let i = 0; i < 120; i++) {
    if (app.exitCode !== null) throw new Error(`next dev stopped:\n${logs}`);
    try { await fetch(`${base}/login`); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  const executablePath = process.env.CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] } : { channel: process.env.CHROME_CHANNEL ?? "chrome" }) });

  const sam = sql(`select id from team_members where email = '${TEAM.email}'`);
  const ctx = await contextFor(browser, TEAM, { width: 1280, height: 900 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const shot = async (name, p = page) => {
    if (!SHOTS) return;
    await p.waitForTimeout(600);
    await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  };
  const postUrl = (id) => `${base}/clients/${CLIENT_A}/social/${id}`;

  // The list: both worker posts, with their review state.
  await page.goto(`${base}/clients/${CLIENT_A}/social`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: /Slow drains/ }).waitFor();
  assert.ok(await page.getByRole("link", { name: /Free estimates on any drain job/ }).getByText("In review", { exact: true }).isVisible());
  assert.ok(await page.getByRole("link", { name: /Slow drains/ }).getByText("Draft", { exact: true }).isVisible());
  assert.equal(await page.getByRole("combobox", { name: /status/i }).count(), 0, "no free status dropdown any more");
  ok("Posts list shows review state; the old free status dropdown is gone");
  await shot("posts-list-desktop");

  // A worker draft with no claim: readiness says why it cannot be submitted.
  await page.goto(postUrl(POST_A), { waitUntil: "networkidle" });
  assert.ok(await page.getByText("A commercial post needs at least one confirmed or sourced claim.").isVisible());
  await page.getByRole("button", { name: "Submit for review" }).click();
  await page.getByRole("alert").filter({ hasText: /needs at least one confirmed or sourced claim/ }).waitFor();
  assert.equal(sql(`select review_status from social_posts where id = '${POST_A}'`), "draft");
  ok("An ungrounded draft cannot be submitted; the page says why");

  // Only usable claims are offered for linking (not the unverified one).
  const options = await page.getByLabel("Link a claim").locator("option").allTextContents();
  assert.ok(options.some((o) => o.includes("Licensed master plumber")));
  assert.ok(!options.some((o) => o.includes("Fastest plumber")), "unverified claim is not offered");
  await page.getByLabel("Link a claim").selectOption({ label: "Licensed master plumber on every job (sourced)" });
  await page.getByRole("button", { name: "Link", exact: true }).click();
  await page.getByText("Grounding checks pass.").waitFor();
  // Media comes from the client's brand assets (post_assets), in order.
  await page.getByLabel("Add a brand asset").selectOption({ label: "Drain job, Nixa (photo)" });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Remove" }).waitFor();
  assert.equal(sql(`select string_agg(brand_asset_id || ':' || sort_order, ',') from post_assets where post_id = '${POST_A}'`), "00000000-0000-4000-f200-00000000000a:1");
  await shot("post-draft-grounded-desktop");
  await page.getByRole("button", { name: "Submit for review" }).click();
  await page.getByRole("button", { name: "Approve" }).waitFor();
  const task = sql(`select t.key || '|' || t.owner || '|' || t.status || '|' || coalesce(t.assignee_id::text, '-') from social_posts p join tasks t on t.id = p.review_task_id where p.id = '${POST_A}'`);
  assert.equal(task, "post_review|CLAUDE_APPROVAL|open|-");
  ok("Linking a claim and a brand asset makes it ready; submitting opens an unassigned CLAUDE_APPROVAL post_review task");

  // The frozen copy: no edit form while in review.
  assert.equal(await page.getByRole("button", { name: "Save draft" }).count(), 0);
  assert.ok(await page.getByText("Submitted content is frozen. Withdraw it to edit.").isVisible());

  // The worker (SQL as postgres) cannot approve, even with a teammate's JWT.
  assert.match(sqlFails(`update social_posts set review_status = 'approved' where id = '${POST_A}'`) ?? "", /Only a signed-in Compass team member/);
  assert.match(
    sqlFails(`set role authenticated; select set_config('request.jwt.claims', '{"role":"authenticated","sub":"${TEAM.id}"}', false); update social_posts set review_status = 'approved' where id = '${POST_A}'`) ?? "",
    /Only a signed-in Compass team member/
  );
  ok("The worker's SQL login cannot approve, even impersonating a teammate");
  await shot("post-in-review-desktop");

  // A person approves through the app.
  await page.getByLabel("Approve").fill("Claim checked against the About page.");
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByText(/Approved by Sam Team/).waitFor();
  const approved = sql(`select review_status || '|' || reviewed_by || '|' || (approved_hash is not null) from social_posts where id = '${POST_A}'`);
  assert.equal(approved, `approved|${sam}|true`);
  assert.equal(sql(`select approved_snapshot -> 'assets' -> 0 ->> 'id' from social_posts where id = '${POST_A}'`), "00000000-0000-4000-f200-00000000000a");
  assert.notEqual(sam, TEAM.id, "team_members id, not the Auth UUID");
  assert.equal(sql(`select t.status from social_posts p join tasks t on t.id = p.review_task_id where p.id = '${POST_A}'`), "done");
  ok("Approval records the team_members id and closes the review task");

  // Schedule; the approval is untouched.
  const before = sql(`select reviewed_by || '|' || reviewed_at || '|' || approved_hash from social_posts where id = '${POST_A}'`);
  await page.getByLabel("Publish at (Central)").fill("2026-10-06T09:30");
  await page.getByRole("button", { name: "Schedule" }).click();
  await page.getByText(/Scheduled for/).waitFor();
  assert.equal(sql(`select publish_status || '|' || to_char(scheduled_at at time zone 'America/Chicago', 'YYYY-MM-DD HH24:MI') from social_posts where id = '${POST_A}'`), "scheduled|2026-10-06 09:30");
  assert.equal(sql(`select reviewed_by || '|' || reviewed_at || '|' || approved_hash from social_posts where id = '${POST_A}'`), before);
  ok("Scheduling (Central time) leaves the approval exactly as it was");
  assert.equal(await page.getByRole("button", { name: "Mark published" }).count(), 0, "no manual publish for a Business Profile post");
  assert.ok(await page.getByText("Business Profile posts are published by the publisher only").isVisible());
  ok("A Business Profile post offers no manual publication");
  await shot("post-approved-scheduled-desktop");

  // A claim losing its source sends it back to review (the lapse).
  sql(`update claims set source = null where id = '00000000-0000-4000-f000-00000000001a'`);
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(sql(`select review_status || '|' || publish_status from social_posts where id = '${POST_A}'`), "in_review|not_scheduled");
  assert.ok(await page.getByText(/What the post stands on changed/).first().isVisible());
  assert.ok(await page.getByText(/marked sourced but has no source/).first().isVisible());
  ok("A claim losing its source sends the approved post back to review, unscheduled, with the reason in history");
  sql(`update claims set source = 'https://a.example.test/about' where id = '00000000-0000-4000-f000-00000000001a'`);

  // The worker's offer post: reject with a reason.
  await page.goto(postUrl(POST_OFFER), { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Reject" }).click();
  // The note is required by the form itself.
  assert.equal(sql(`select review_status from social_posts where id = '${POST_OFFER}'`), "in_review");
  await page.getByLabel("Reject").fill("“Fastest” is not a claim we can stand on. Lead with the free estimate.");
  await page.getByRole("button", { name: "Reject" }).click();
  await page.getByText(/Rejected by Sam Team/).waitFor();
  assert.equal(sql(`select review_status || '|' || reviewed_by from social_posts where id = '${POST_OFFER}'`), `rejected|${sam}`);
  ok("Rejecting needs a reason and records who rejected");
  await shot("post-rejected-desktop");

  // The Facebook post: approve, then record a manual publication.
  await page.goto(postUrl(POST_FB), { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByText(/Approved by Sam Team/).waitFor();
  const fbApproval = sql(`select reviewed_by || '|' || reviewed_at || '|' || approved_hash from social_posts where id = '${POST_FB}'`);
  const minuteAgo = sql(`select to_char((now() - interval '2 minutes') at time zone 'America/Chicago', 'YYYY-MM-DD"T"HH24:MI')`);
  await page.getByLabel("Post link").fill("https://facebook.example/harborlane/posts/1");
  await page.getByLabel("Published at (Central)").fill(minuteAgo);
  await shot("post-mark-published-desktop");
  await page.getByRole("button", { name: "Mark published" }).click();
  await page.getByText(/^Published .* · view$/).waitFor({ timeout: 15000 }).catch(async (e) => {
    console.log("alerts:", await page.getByRole("alert").allTextContents());
    throw e;
  });
  assert.equal(
    sql(`select publish_status || '|' || coalesce(external_post_id, '-') || '|' || published_url || '|' || (reviewed_by || '|' || reviewed_at || '|' || approved_hash) from social_posts where id = '${POST_FB}'`),
    `published|-|https://facebook.example/harborlane/posts/1|${fbApproval}`
  );
  assert.equal(sql(`select actor_kind || '|' || actor_id || '|' || (detail ->> 'manual') from post_events where post_id = '${POST_FB}' and kind = 'published'`), `team|${sam}|true`);
  ok("A person marks an approved Facebook post published by hand; approval unchanged; event names them");
  await shot("post-published-by-hand-desktop");

  // A person's own navigational post, CRM facts only, approved by its author.
  await page.goto(`${base}/clients/${CLIENT_A}/social?view=new`, { waitUntil: "networkidle" });
  await page.getByLabel("Search intent").selectOption("navigational");
  await page.getByLabel("Copy").fill("Harbor Lane Plumbing — call (417) 555-0100 or book at a.example.test.");
  await page.getByLabel(/CRM facts only/).check();
  await page.getByLabel("Link", { exact: true }).fill("https://a.example.test/contact");
  await shot("post-new-desktop");
  await page.getByRole("button", { name: "Create draft" }).click();
  await page.waitForURL(/\/social\/[0-9a-f-]{36}$/);
  const mine = page.url().split("/").at(-1);
  assert.equal(sql(`select author_kind || '|' || created_by from social_posts where id = '${mine}'`), `human|${sam}`);
  await page.getByText("Grounding checks pass.").waitFor();
  await page.getByRole("button", { name: "Submit for review" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByText(/Approved by Sam Team/).waitFor();
  assert.equal(sql(`select reviewed_by from social_posts where id = '${mine}'`), sam);
  ok("A person drafts a CRM-facts-only navigational post and approves their own draft");

  // The review task links back to the post.
  const reviewTask = sql(`select review_task_id from social_posts where id = '${POST_A}'`);
  await page.goto(`${base}/tasks/${reviewTask}`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: /Open the post to approve or reject it/ }).click();
  await page.waitForURL(new RegExp(`/social/${POST_A}$`));
  ok("The review task links to its post");

  // Reports tab still loads (reads publish_status now).
  await page.goto(`${base}/clients/${CLIENT_A}/reports`, { waitUntil: "networkidle" });
  assert.equal(await page.getByText(/Application error|Unhandled Runtime Error/).count(), 0);
  ok("Reports tab loads with the new published count");

  // Mobile.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [url, name] of [[`${base}/clients/${CLIENT_A}/social`, "posts-list-mobile"], [postUrl(POST_A), "post-detail-mobile"]]) {
    await page.goto(url, { waitUntil: "networkidle" });
    assert.ok(await noHorizontalScroll(page), `no horizontal scroll at 390px: ${name}`);
    await shot(name);
  }
  ok("Mobile (390px): list and detail fit without horizontal scrolling");

  assert.deepEqual(errors, []);

  // A portal contact reads nothing through the API.
  const asPortal = { apikey: anonKey, authorization: `Bearer ${tokenFor(PORTAL)}`, "content-type": "application/json" };
  for (const t of ["social_posts", "post_claims", "post_events"]) {
    const r = await fetch(`${gatewayUrl}/rest/v1/${t}?select=*`, { headers: asPortal });
    assert.deepEqual(await r.json(), [], `${t} empty for a portal user`);
  }
  const rpc = await fetch(`${gatewayUrl}/rest/v1/rpc/social_post_readiness`, { method: "POST", headers: asPortal, body: JSON.stringify({ p_post_id: POST_A }) });
  assert.ok(rpc.status >= 400, `portal readiness refused (${rpc.status})`);
  ok("Portal contact: no posts, links or history through the API; readiness refused");

  assert.deepEqual(unexpected, []);
  console.log(`Posts browser checks passed (${checks.length}).${SHOTS ? ` Screenshots in ${SHOTS}.` : ""}`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
