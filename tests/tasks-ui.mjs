// Browser acceptance check for the tasks slice (0043). Run by
// scripts/test-tasks-ui.sh, which provides a real Postgres replay behind
// PostgREST (PGRST_URL, JWT_SECRET) and a psql command (PSQL). This file adds
// a stand-in for Supabase Auth's /user endpoint, runs `next dev` against it
// and drives Chrome. Fictional data only; nothing leaves the machine.
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

const port = Number(process.env.TASKS_UI_PORT ?? 3418);
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

async function until(fn, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${label}`);
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
try {
  for (let i = 0; i < 120; i++) {
    if (app.exitCode !== null) throw new Error(`next dev stopped:\n${logs}`);
    try { await fetch(`${base}/login`); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  const executablePath = process.env.CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] } : { channel: process.env.CHROME_CHANNEL ?? "chrome" }) });

  const sam = sql(`select id from team_members where email = '${TEAM.email}'`);
  const jess = sql(`select id from team_members where email = 'jess@compassmarketing.ai'`);
  const pipelineTask = sql(`select title from tasks where client_id = '${CLIENT_A}' and client_stage_id is not null and owner = 'CLAUDE' and status <> 'done' order by title limit 1`);

  const ctx = await contextFor(browser, TEAM, { width: 1280, height: 900 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Let CSS transitions and the dev-mode indicator settle before capturing.
  const shot = async (name, p = page) => {
    if (!SHOTS) return;
    await p.waitForTimeout(600);
    await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  };
  const row = (title) => page.locator("div.grid").filter({ has: page.getByRole("link", { name: title, exact: true }) }).last();

  // All open: pipeline, monthly and hand-made work together, as before.
  await page.goto(`${base}/tasks`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Tasks" }).waitFor();
  assert.ok(await page.getByRole("link", { name: pipelineTask, exact: true }).first().isVisible());
  assert.ok(await page.getByRole("link", { name: "Draft September blog post", exact: true }).isVisible());
  ok("All open lists worker-created pipeline tasks alongside hand-made ones");
  await shot("tasks-all-open-desktop");

  // Unassigned: human work nobody has, without the worker's lane.
  await page.getByRole("link", { name: /^Unassigned/ }).click();
  await page.waitForURL(/view=unassigned/);
  assert.ok(await page.getByRole("link", { name: "Collect job-site photos from the client", exact: true }).isVisible());
  assert.equal(await page.getByRole("link", { name: "Draft September blog post", exact: true }).count(), 0);
  assert.equal(await page.getByRole("link", { name: "Confirm holiday hours for the GBP", exact: true }).count(), 0);
  assert.ok(await page.getByRole("link", { name: "Approve the GBP primary category", exact: true }).isVisible());
  assert.equal(await row("Approve the GBP primary category").getByLabel("Assignee", { exact: true }).count(), 1);
  ok("Unassigned shows unowned human work (CLAUDE_APPROVAL included, assignable), not CLAUDE-lane or assigned tasks");
  await shot("tasks-unassigned-desktop");

  // Create an assigned, overdue task.
  // The Overdue view is Central-time today (todayIn), so "yesterday" is too;
  // the database's UTC date runs ahead of it between 00:00 and 05:00 UTC.
  const yesterday = sql(`select to_char((now() at time zone 'America/Chicago')::date - 1, 'YYYY-MM-DD')`);
  await page.locator("summary", { hasText: "New task" }).click();
  await page.getByLabel("Task", { exact: true }).fill("Send the September report");
  await page.getByLabel("Client", { exact: true }).selectOption({ label: "Harbor Lane Plumbing" });
  await page.getByLabel("Assignee", { exact: true }).first().selectOption({ label: "Jess Rivera" });
  await page.getByLabel("Due", { exact: true }).fill(yesterday);
  await page.getByRole("button", { name: "Add task" }).click();
  await until(() => sql(`select count(*) from tasks where title = 'Send the September report'`) === "1", "task created");
  const created = sql(`select client_id || '|' || assignee_id || '|' || created_by || '|' || owner || '|' || coalesce(autonomy_level::text, '-') from tasks where title = 'Send the September report'`);
  assert.equal(created, `${CLIENT_A}|${jess}|${sam}|TOM|-`);
  ok("New task: client, assignee and author recorded; worker fields keep their defaults");

  await page.goto(`${base}/tasks?view=overdue`, { waitUntil: "networkidle" });
  assert.ok(await page.getByRole("link", { name: "Send the September report", exact: true }).isVisible());
  assert.ok(await page.getByRole("link", { name: "Collect job-site photos from the client", exact: true }).isVisible());
  assert.equal(await page.getByRole("link", { name: "Confirm holiday hours for the GBP", exact: true }).count(), 0);
  ok("Overdue shows open tasks past due, not future ones");
  await shot("tasks-overdue-desktop");

  // Inline assignment from a list.
  await row("Collect job-site photos from the client").getByLabel("Assignee").selectOption({ label: "Sam Team (me)" });
  await until(() => sql(`select assignee_id from tasks where title = 'Collect job-site photos from the client'`) === sam, "inline assign");
  await page.goto(`${base}/tasks?view=mine`, { waitUntil: "networkidle" });
  assert.ok(await page.getByRole("link", { name: "Collect job-site photos from the client", exact: true }).isVisible());
  assert.equal(await page.getByRole("link", { name: "Send the September report", exact: true }).count(), 0);
  ok("Inline assignee picker saves; My work shows only my tasks");
  await shot("tasks-my-work-desktop");

  await page.goto(`${base}/tasks?view=by_client`, { waitUntil: "networkidle" });
  assert.ok(await page.getByRole("heading", { name: /Harbor Lane Plumbing/ }).isVisible());
  assert.ok(await page.getByRole("heading", { name: /Summit Electric/ }).isVisible());
  ok("By client groups open work under each client");

  // The worker's lane: no picker on the list, a disabled one on the task,
  // and a forged submit is refused by the server action.
  const claudeRow = row("Draft September blog post");
  await page.goto(`${base}/tasks`, { waitUntil: "networkidle" });
  assert.equal(await claudeRow.getByLabel("Assignee", { exact: true }).count(), 0);
  assert.ok(await claudeRow.getByText("Worker runs this", { exact: true }).isVisible());
  assert.equal(await row("Collect job-site photos from the client").getByLabel("Assignee", { exact: true }).count(), 1);
  await page.getByRole("link", { name: "Draft September blog post", exact: true }).click();
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  const picker = page.getByLabel("Assignee", { exact: true });
  assert.ok(await picker.isDisabled());
  assert.ok(await page.getByText("The worker runs CLAUDE tasks, so they aren't assigned to a person.").isVisible());
  await shot("task-detail-claude-lane-desktop");
  // Forge it: re-enable the select in the DOM and submit.
  await picker.evaluate((el) => el.removeAttribute("disabled"));
  await picker.selectOption({ label: "Sam Team (me)" });
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("alert").filter({ hasText: "can't be assigned to a person" }).waitFor();
  assert.equal(sql(`select coalesce(assignee_id::text, 'none') from tasks where title = 'Draft September blog post'`), "none");
  ok("CLAUDE lane: no picker in lists, disabled on the task, forged submit refused by the server action");
  await shot("tasks-by-client-desktop");

  // Detail: edit, comment, history with names.
  await page.goto(`${base}/tasks?view=mine`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Collect job-site photos from the client", exact: true }).click();
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  await page.getByLabel("Status", { exact: true }).selectOption("in_progress");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText("Saved.", { exact: true }).waitFor();
  await page.getByLabel("Comment", { exact: true }).fill("Client says the photos arrive Friday.");
  await page.getByRole("button", { name: "Comment" }).click();
  await page.getByText("Client says the photos arrive Friday.", { exact: true }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  for (const line of ["Worker / system created the task", "Sam Team took the task", "Sam Team changed status from open to in progress"]) {
    assert.ok(await page.getByText(line).first().isVisible(), line);
  }
  assert.match(await page.locator("dl").innerText(), /Last change\s+.+ by Sam Team/);
  assert.equal(sql(`select author_id from task_comments where body = 'Client says the photos arrive Friday.'`), sam);
  ok("Detail page: status saved, comment posted with author, history names who changed what");
  await shot("task-detail-desktop");

  // The existing completion flow, on the client's Tasks tab, still fires the worker for a gate task.
  await page.goto(`${base}/clients/${CLIENT_A}/tasks`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Tasks", exact: true }).first().waitFor();
  await shot("client-tasks-tab-desktop");
  await page.getByRole("button", { name: "Mark “Client review of the staging site” done" }).click();
  await until(() => sql(`select status || '|' || (completed_at is not null) from tasks where title = 'Client review of the staging site'`) === "done|true", "toggle done");
  await until(() => sql(`select count(*) from worker_fires where client_id = '${CLIENT_A}' and reason = 'client_review done'`) === "1", "worker fire");
  assert.equal(sql(`select updated_by from tasks where title = 'Client review of the staging site'`), sam);
  ok("Existing done toggle: status + completed_at set, client_review still fires the worker, change attributed");

  // Mobile.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/tasks?view=overdue`, { waitUntil: "networkidle" });
  assert.ok(await noHorizontalScroll(page), "no horizontal scroll on /tasks at 390px");
  assert.ok(await row("Send the September report").getByLabel("Assignee").isVisible());
  await shot("tasks-overdue-mobile");
  await page.getByRole("link", { name: "Send the September report", exact: true }).click();
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  assert.ok(await noHorizontalScroll(page), "no horizontal scroll on task detail at 390px");
  await shot("task-detail-mobile");
  await page.goto(`${base}/clients/${CLIENT_A}/tasks`, { waitUntil: "networkidle" });
  assert.ok(await noHorizontalScroll(page), "no horizontal scroll on client tasks at 390px");
  await shot("client-tasks-tab-mobile");
  ok("Mobile (390px): lists, detail and client tab fit without horizontal scrolling");

  assert.deepEqual(errors, []);

  // A portal contact: the CRM sends them to /portal, and the API gives them nothing.
  const pctx = await contextFor(browser, PORTAL, { width: 1280, height: 900 });
  const ppage = await pctx.newPage();
  await ppage.goto(`${base}/tasks`, { waitUntil: "networkidle" });
  assert.match(new URL(ppage.url()).pathname, /^\/portal/);
  const asPortal = { apikey: anonKey, authorization: `Bearer ${tokenFor(PORTAL)}`, "content-type": "application/json" };
  for (const t of ["tasks", "task_comments", "task_events"]) {
    const r = await fetch(`${gatewayUrl}/rest/v1/${t}?select=id`, { headers: asPortal });
    assert.deepEqual(await r.json(), [], `${t} empty for a portal user`);
  }
  const taskId = sql(`select id from tasks where title = 'Send the September report'`);
  const post = await fetch(`${gatewayUrl}/rest/v1/task_comments`, { method: "POST", headers: asPortal, body: JSON.stringify({ task_id: taskId, client_id: CLIENT_A, body: "hi" }) });
  assert.ok(post.status >= 400, `portal comment refused (${post.status})`);
  const patch = await fetch(`${gatewayUrl}/rest/v1/tasks?id=eq.${taskId}`, { method: "PATCH", headers: { ...asPortal, prefer: "return=representation" }, body: JSON.stringify({ assignee_id: null }) });
  assert.deepEqual(await patch.json(), []);
  assert.equal(sql(`select assignee_id from tasks where id = '${taskId}'`), jess);
  ok("Portal contact: redirected to /portal; reads nothing and changes nothing through the API");

  assert.deepEqual(unexpected, []);
  console.log(`Tasks browser checks passed (${checks.length}).${SHOTS ? ` Screenshots in ${SHOTS}.` : ""}`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
