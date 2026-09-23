// Isolated browser acceptance test. All auth/REST traffic goes to a local fake;
// no production keys, real client records or external provider calls are used.
// Run: npm run test:reporting-ui (install Playwright Chromium first).
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const clientId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000011";
const user = { id: userId, email: "reviewer@example.test", aud: "authenticated", role: "authenticated" };
const fixture = {
  client_id: clientId, metric: "search_clicks", scope: "example.test web US", source: "Fixture export",
  platform: "none", channel: "none", context: "existing_client", status: "measured", evidence: "Synthetic test evidence",
  meaning: "Search clicks increased.", next_action: "Review the priority pages.", recorded_by: userId, created_at: "2026-09-01T00:00:00Z",
};
const rows = [
  { ...fixture, id: "00000000-0000-4000-8000-000000000021", sequence: 1, report_period: "2026-07-01", window_start: "2026-07-01", window_end: "2026-07-31", value: 10 },
  { ...fixture, id: "00000000-0000-4000-8000-000000000022", sequence: 2, report_period: "2026-08-01", window_start: "2026-08-01", window_end: "2026-08-31", value: 20 },
];
let failNextInsert = true;
const unexpected = [];
const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const reply = (data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
  if (url.pathname === "/auth/v1/user") return reply(user);
  if (url.pathname === "/rest/v1/rpc/is_team") return reply(true);
  // The app layout (PR #51) signs out anyone without a team_members row.
  if (url.pathname === "/rest/v1/team_members") return reply([{ id: "00000000-0000-4000-8000-000000000031" }]);
  if (url.pathname === "/rest/v1/clients") {
    assert.equal(url.searchParams.get("id"), `eq.${clientId}`);
    return reply({ id: clientId, name: "Fictional scorecard sandbox", status: "launching", dba: null, website_url: null });
  }
  if (["monthly_cycles", "content_posts", "social_posts"].some((name) => url.pathname === `/rest/v1/${name}`)) return reply([]);
  if (url.pathname === "/rest/v1/report_measurements") {
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (failNextInsert) { failNextInsert = false; return reply({ code: "TEST_FAILURE", message: "Simulated temporary failure" }, 400); }
      const input = JSON.parse(body);
      assert.equal(input.client_id, clientId);
      rows.push({ ...input, sequence: rows.length + 1, created_at: new Date().toISOString(), recorded_by: userId });
      return reply(null, 201);
    }
    assert.equal(url.searchParams.get("client_id"), `eq.${clientId}`);
    return reply(rows);
  }
  unexpected.push(`${req.method} ${url.pathname}`);
  reply({ message: "Unexpected fixture request" }, 500);
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;
const port = Number(process.env.REPORT_UI_PORT ?? 3417);
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${upstreamPort}`, NEXT_PUBLIC_SUPABASE_ANON_KEY: "fictional-local-test-key", NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
app.stdout.on("data", (chunk) => { logs = (logs + chunk).slice(-5000); });
app.stderr.on("data", (chunk) => { logs = (logs + chunk).slice(-5000); });
let browser;
try {
  for (let tries = 0; tries < 90; tries++) {
    if (app.exitCode !== null) throw new Error(`Local app stopped: ${logs}`);
    try { await fetch(`http://127.0.0.1:${port}/login`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  browser = await chromium.launch({ headless: true,
    ...(process.env.REPORT_UI_CHROMIUM_PATH ? { executablePath: process.env.REPORT_UI_CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const tokenPart = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const access = `${tokenPart({ alg: "HS256", typ: "JWT" })}.${tokenPart({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`;
  const session = { access_token: access, refresh_token: "fixture", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: "bearer", user };
  await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${tokenPart(session)}`, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/clients/${clientId}/reports?scorecard_month=2026-08`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "2026-08 marketing scorecard" }).waitFor();
  // Tom's decisions (Sept 22): say the numbers are recorded by hand, and keep
  // the monthly cycle cards and report_send reachable in the collapsible.
  assert.ok(await page.getByText("Recorded by hand.", { exact: true }).isVisible());
  const workflow = page.locator("summary").filter({ hasText: "Monthly workflow & earlier reports" });
  assert.equal(await workflow.count(), 1);
  assert.match(await workflow.innerText(), /open cycle tasks, including Send report, are here/);
  // Two months, two meanings: the scorecard uses Central time, cycles use UTC months.
  assert.ok(await page.getByText("Data months and dates here use Compass's day (Central time).", { exact: false }).isVisible());
  await workflow.click();
  assert.ok(await page.getByText("Cycles are named by their UTC", { exact: false }).isVisible());
  assert.equal(await page.locator('section[aria-label="Client marketing scorecard"] > div.grid > details').count(), 9);
  assert.ok(await page.getByText("vs previous: +10", { exact: true }).isVisible());
  assert.ok(await page.getByText("vs baseline: +10", { exact: true }).isVisible());
  await page.getByText("Record a measurement", { exact: true }).click();
  await page.getByRole("button", { name: "Start an entry" }).click();
  await page.locator('input[name="scope"]').fill("Priority pages v1");
  await page.locator('input[name="source"]').fill("Fixture page audit");
  await page.locator('input[name="window_start"]').fill("2026-08-15");
  await page.locator('input[name="window_end"]').fill("2026-08-15");
  await page.locator('input[name="value"]').fill("0");
  await page.locator('input[name="evidence"]').fill("Synthetic page inventory");
  await page.locator('textarea[name="meaning"]').fill("No priority pages live in the fictional fixture.");
  await page.locator('textarea[name="next_action"]').fill("Review the page plan.");
  await page.getByRole("button", { name: "Save verified entry" }).click();
  await page.getByRole("alert").filter({ hasText: "could not be saved" }).waitFor();
  assert.equal(await page.locator('input[name="value"]').inputValue(), "0");
  assert.equal(await page.locator('input[name="scope"]').inputValue(), "Priority pages v1");
  await page.getByRole("button", { name: "Save verified entry" }).click();
  await page.getByText("Measurement saved with its source and history.", { exact: true }).waitFor();
  assert.equal(rows.length, 3);
  await page.getByRole("button", { name: "Record another measurement" }).click();
  await page.locator('select[name="metric"]').selectOption("social_followers");
  assert.ok(await page.locator('select[name="platform"]').isVisible());
  assert.ok(await page.locator('select[name="channel"]').isVisible());
  await page.setViewportSize({ width: 390, height: 844 });
  const scroller = page.locator('section[aria-label="Client marketing scorecard"] .overflow-x-auto').first();
  assert.ok(await scroller.evaluate((node) => node.scrollWidth > node.clientWidth));
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log("Reporting browser checks passed: nine areas, deltas, error retention, save, social controls and mobile table scrolling. Fictional local data only.");
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
}
