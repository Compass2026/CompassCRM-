// Design preview: renders the team CRM against fictional data and saves
// desktop + phone screenshots, so a visual change can be reviewed without a
// Supabase project. A local stand-in answers /auth/v1/user and /rest/v1/*
// from the fixtures below (with simple eq / neq / in / lt / gt filters), runs
// `next dev` against it and drives Chromium. Nothing leaves the machine and
// nothing is written anywhere but the screenshot folder.
//
//   npm run design:preview                       # docs/screenshots/design-refresh
//   SCREENSHOTS=/tmp/shots npm run design:preview
//   PAGES=dashboard,tasks npm run design:preview # a subset
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { chromium } from "playwright-core";

const OUT = process.env.SCREENSHOTS ?? "docs/screenshots/design-refresh";
mkdirSync(OUT, { recursive: true });

// ---- fictional data --------------------------------------------------------
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER = { id: uid(900), email: "sam.rivera@example.test", aud: "authenticated", role: "authenticated" };
const ME = { id: uid(901), name: "Sam Rivera", email: USER.email };
const JESS = { id: uid(902), name: "Jess Park", email: "jess.park@example.test" };

const pipelines = {
  foundation: { name: "Foundation", key: "foundation", is_recurring: false },
  website: { name: "Website", key: "website", is_recurring: false },
  seo: { name: "SEO", key: "seo", is_recurring: false },
  reporting: { name: "Reporting", key: "reporting", is_recurring: true },
};
const stages = (done, total, blocked = 0) =>
  Array.from({ length: total }, (_, i) => ({
    status: i < done ? "complete" : i < done + blocked ? "blocked" : "not_started",
  }));
const clientDefs = [
  ["Ridgeline Roofing", "active", [["foundation", 3, 3], ["website", 4, 4], ["seo", 5, 5], ["reporting", 0, 0]]],
  ["Harbor Dental Studio", "launching", [["foundation", 3, 3], ["website", 2, 4], ["seo", 3, 5]]],
  ["Summit Electric Co.", "launching", [["foundation", 3, 3], ["website", 1, 4, 1], ["seo", 1, 5]]],
  ["Maple Street Bakery", "launching", [["foundation", 1, 3], ["website", 0, 4], ["seo", 0, 5]]],
  ["Northfield Landscaping", "active", [["foundation", 3, 3], ["website", 4, 4], ["seo", 4, 5]]],
  ["Bluewater Pool Service", "paused", [["foundation", 3, 3], ["website", 3, 4], ["seo", 2, 5, 1]]],
];
const clients = clientDefs.map(([name, status, pls], i) => ({
  id: uid(100 + i),
  name,
  dba: null,
  status,
  website_url: `https://${name.toLowerCase().replace(/[^a-z]+/g, "")}.example`,
  industry: ["Roofing", "Dental", "Electrical", "Bakery", "Landscaping", "Pools"][i],
  vertical: ["roofing", "dental", "electrical", "bakery", "landscaping", "pools"][i],
  home_city: ["Columbia", "Jefferson City", "Springfield", "Lake Ozark", "Rolla", "Osage Beach"][i],
  home_state: "MO",
  created_at: "2026-08-01T15:00:00Z",
  launched_at: status === "active" ? "2026-09-01T15:00:00Z" : null,
  client_pipelines: pls.map(([key, done, total, blocked = 0], j) => ({
    id: uid(200 + i * 10 + j),
    client_id: uid(100 + i),
    status: done === total && total > 0 ? "complete" : key === "reporting" ? "active" : "active",
    pipelines: pipelines[key],
    client_stages: stages(done, total, blocked),
  })),
}));
const C = (i) => ({ id: clients[i].id, name: clients[i].name });

const blockedStages = [
  { id: uid(300), status: "blocked", next_action: "DNS records for the new domain", evidence: null, stages: { name: "Launch" }, client_pipelines: { client_id: C(2).id, pipelines: { name: "Website" }, clients: C(2) } },
  { id: uid(301), status: "blocked", next_action: "Business Profile manager access", evidence: null, stages: { name: "GBP Setup & Optimisation" }, client_pipelines: { client_id: C(5).id, pipelines: { name: "SEO" }, clients: C(5) } },
];

const task = (n, o) => ({
  id: uid(400 + n),
  status: "open",
  due_date: null,
  autonomy_level: null,
  flagged_for_review: false,
  recommendation: null,
  playbook_step: null,
  completed_at: null,
  notes: null,
  key: null,
  default_if_approved: null,
  created_at: "2026-09-18T14:00:00Z",
  updated_at: "2026-09-22T16:30:00Z",
  assignee_id: null,
  monthly_cycle_id: null,
  client_stages: null,
  assignee: null,
  updater: null,
  ...o,
  client_id: o.clients.id,
});
const tasks = [
  task(1, { title: "Send the DNS records to the client's IT contact", owner: "TOM", due_date: "2026-09-19", clients: C(2), client_stages: { stages: { name: "Launch" } }, assignee_id: ME.id, assignee: ME, updater: ME }),
  task(2, { title: "Approve the September blog topic list", owner: "CLAUDE_APPROVAL", autonomy_level: "hold", clients: C(1), due_date: "2026-09-25", client_stages: { stages: { name: "Polish & client review" } } }),
  task(3, { title: "Client review of the staging site", owner: "TOM", due_date: "2026-09-26", clients: C(1), client_stages: { stages: { name: "Polish & client review" } }, assignee_id: JESS.id, assignee: JESS, updater: JESS }),
  task(4, { title: "Draft four Business Profile posts for October", owner: "CLAUDE", autonomy_level: "run_flag", flagged_for_review: true, recommendation: "Posts are in Drive; the second one leans on a seasonal offer the client should confirm.", clients: C(0), client_stages: { stages: { name: "GBP Setup & Optimisation" } } }),
  task(5, { title: "Grant Business Profile manager access", owner: "WAITING", status: "blocked", clients: C(5), due_date: "2026-09-15", client_stages: { stages: { name: "GBP Setup & Optimisation" } } }),
  task(6, { title: "Refresh the service-area city pages", owner: "CLAUDE", autonomy_level: "run", clients: C(4), monthly_cycle_id: uid(600) }),
  task(7, { title: "Collect six job-site photos from the owner", owner: "DELEGATED", clients: C(3), due_date: "2026-10-02", client_stages: { stages: { name: "Brand Build" } } }),
];

const subscriptions = [
  { id: uid(500), client_id: C(5).id, amount: 1450, current_period_end: "2026-09-12T00:00:00Z", paid_status: "past_due", clients: C(5) },
];

const measurement = (n, metric, value, period, extra = {}) => ({
  id: uid(700 + n), client_id: C(0).id, sequence: n, metric, scope: "ridgelineroofing.example", source: "Search Console export",
  platform: "none", channel: "none", context: "existing_client", status: "measured", evidence: "Fictional preview evidence",
  meaning: null, next_action: null, recorded_by: USER.id, created_at: "2026-09-02T00:00:00Z",
  report_period: period, window_start: period, window_end: period.replace(/-01$/, "-28"), value, ...extra,
});
const reportMeasurements = [
  measurement(1, "search_clicks", 212, "2026-07-01"),
  measurement(2, "search_clicks", 268, "2026-08-01", { meaning: "Clicks rose after the city pages went live.", next_action: "Extend the city pages to two more towns." }),
  measurement(3, "search_impressions", 9100, "2026-07-01"),
  measurement(4, "search_impressions", 11850, "2026-08-01"),
  measurement(5, "leads", 14, "2026-07-01", { source: "Call tracking export" }),
  measurement(6, "leads", 19, "2026-08-01", { source: "Call tracking export" }),
];

const monthlyCycles = [
  {
    id: uid(600), client_id: C(0).id, period: "2026-09-01", status: "open", report_url: "https://docs.example/report", summary: null,
    rank_summary: { organic_index: 62, map_index: 71, keywords_tracked: 50, top3: 9, top10: 22 }, created_at: "2026-09-01T06:00:00Z",
    tasks: [
      { id: uid(610), title: "Monthly report", owner: "CLAUDE", status: "done" },
      { id: uid(611), title: "Industry pulse", owner: "CLAUDE", status: "done" },
      { id: uid(612), title: "Send report", owner: "TOM", status: "open" },
    ],
  },
];

const tables = {
  clients,
  client_pipelines: clients.flatMap((c) => c.client_pipelines),
  client_stages: blockedStages,
  tasks,
  subscriptions,
  team_members: [ME, JESS].map((m) => ({ ...m, auth_user_id: m === ME ? USER.id : null })),
  report_measurements: reportMeasurements,
  monthly_cycles: monthlyCycles,
};

// ---- a PostgREST-shaped stand-in ------------------------------------------
const RESERVED = new Set(["select", "order", "limit", "offset", "or", "and", "on_conflict", "columns"]);
function applyFilters(rows, params) {
  let out = rows;
  for (const [key, raw] of params) {
    if (RESERVED.has(key) || key.includes(".")) continue;
    const m = /^(not\.)?(eq|neq|in|is|lt|lte|gt|gte)\.(.*)$/.exec(raw);
    if (!m) continue;
    const [, not, op, value] = m;
    out = out.filter((row) => {
      if (!(key in row)) return true;
      const v = row[key];
      let hit;
      if (op === "eq") hit = String(v) === value;
      else if (op === "neq") hit = String(v) !== value;
      else if (op === "in") hit = value.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/"/g, "")).includes(String(v));
      else if (op === "is") hit = value === "null" ? v == null : String(v) === value;
      else if (v == null) hit = false;
      else hit = { lt: v < value, lte: v <= value, gt: v > value, gte: v >= value }[op];
      return not ? !hit : hit;
    });
  }
  const limit = Number(params.get("limit"));
  return limit ? out.slice(0, limit) : out;
}

const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, data, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(data === undefined ? "" : JSON.stringify(data));
  };
  if (url.pathname === "/auth/v1/user") return send(200, USER);
  if (url.pathname.startsWith("/rest/v1/rpc/")) {
    const fn = url.pathname.slice("/rest/v1/rpc/".length);
    return send(200, fn === "is_team" ? true : fn === "secret_present" ? false : null);
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    if (!["GET", "HEAD"].includes(req.method)) return send(201, null);
    const table = url.pathname.slice("/rest/v1/".length);
    const rows = applyFilters(tables[table] ?? [], url.searchParams);
    const range = `0-${Math.max(rows.length - 1, 0)}/${rows.length}`;
    if (req.method === "HEAD") return send(200, undefined, { "content-range": range });
    const single = (req.headers.accept ?? "").includes("vnd.pgrst.object");
    if (single) return rows.length ? send(200, rows[0]) : send(406, { code: "PGRST116", message: "no rows" });
    return send(200, rows, { "content-range": range });
  }
  send(404, { message: "not in the preview gateway" });
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;

// ---- app + browser ---------------------------------------------------------
const port = Number(process.env.PREVIEW_PORT ?? 3419);
const base = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: gatewayUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: "fictional-preview-key", NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
app.stdout.on("data", (c) => { logs = (logs + c).slice(-8000); });
app.stderr.on("data", (c) => { logs = (logs + c).slice(-8000); });

const pages = [
  ["dashboard", "/"],
  ["clients", "/clients"],
  ["tasks", "/tasks"],
  ["brief", "/brief"],
  ["settings", "/settings"],
  ["login", "/login"],
  ["task-detail", `/tasks/${uid(401)}`],
  ["client-overview", `/clients/${C(0).id}`],
  ...["plan", "brand", "documents", "pipelines", "tasks", "foundation", "services", "keywords", "content", "social", "reports", "billing"]
    .map((tab) => [`client-${tab}`, `/clients/${C(0).id}/${tab}`]),
];
const wanted = process.env.PAGES?.split(",");
const viewports = [
  ["desktop", { width: 1280, height: 900 }],
  ["phone", { width: 390, height: 844 }],
];

const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
const executablePath = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", process.env.CHROME_PATH].find((p) => p && existsSync(p));
let browser;
let failed = false;
try {
  for (let i = 0; i < 120; i++) {
    if (app.exitCode !== null) throw new Error(`next dev stopped:\n${logs}`);
    try { await fetch(`${base}/login`); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: "chrome" }) });
  for (const [vpName, viewport] of viewports) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: vpName === "phone" ? 1.5 : 1 });
    const session = { access_token: "preview", refresh_token: "preview", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: "bearer", user: USER };
    const signIn = () => context.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64(session)}`, domain: "127.0.0.1", path: "/" }]);
    await signIn();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    for (const [name, path] of pages) {
      if (wanted && !wanted.includes(name)) continue;
      // The login page redirects a signed-in user, so shoot it signed out.
      if (name === "login") await context.clearCookies();
      const resp = await page.goto(`${base}${path}`, { waitUntil: "networkidle", timeout: 120_000 });
      // The dev-mode badge is not part of the design.
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      await page.waitForTimeout(700);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      await page.screenshot({ path: `${OUT}/${name}-${vpName}.jpg`, fullPage: true, type: "jpeg", quality: 85 });
      const note = [resp?.status() !== 200 && `HTTP ${resp?.status()}`, wide && "horizontal scroll"].filter(Boolean);
      if (name === "login") await signIn();
      if (note.length) failed = true;
      console.log(`${note.length ? "✘" : "✔"} ${name} (${vpName})${note.length ? ` — ${note.join(", ")}` : ""}`);
    }
    if (errors.length) { failed = true; console.log("page errors:", errors); }
    await context.close();
  }
} catch (e) {
  failed = true;
  console.error(e.message, logs);
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.close();
}
console.log(`screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
