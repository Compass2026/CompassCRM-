// End-to-end check of sign-in and password recovery against a REAL Supabase
// Auth server (supabase/auth, a.k.a. GoTrue), the sandbox Postgres replay
// behind PostgREST, a production build of the app (`next build` + `next
// start`) and Chromium. Nothing leaves the machine: email goes to an SMTP
// sink in this file, and no Supabase project, user or session is touched.
//
//   GOTRUE_BIN=/path/to/auth GOTRUE_MIGRATIONS=/path/to/supabase-auth/migrations \
//   CHROME_PATH=/path/to/chromium npm run test:auth-ui
//
// Build GOTRUE_BIN from https://github.com/supabase/auth (`go build -o auth .`);
// GOTRUE_MIGRATIONS is that checkout's migrations/ directory. Run through
// scripts/test-tasks-ui.sh with PG_LISTEN=127.0.0.1 (the npm script does).
//
// Three origins stand in for the deployments Supabase's URL configuration
// must cover (docs/password-recovery.md):
//   production  http://127.0.0.1:<port>          the Site URL
//   preview     http://localhost:<port>          on the Redirect URLs list
//   unlisted    http://unlisted.localhost:<port> on neither (falls back)
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHmac, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const { PGRST_URL, JWT_SECRET, PG_BIN, PG_PORT, GOTRUE_BIN } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PG_BIN && PG_PORT, "run through scripts/test-tasks-ui.sh with PG_LISTEN=127.0.0.1");
assert.ok(GOTRUE_BIN, "set GOTRUE_BIN to a supabase/auth binary");
const GOTRUE_MIGRATIONS = process.env.GOTRUE_MIGRATIONS ?? path.join(path.dirname(GOTRUE_BIN), "migrations");
const SHOTS = process.env.SCREENSHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const APP_PORT = Number(process.env.AUTH_UI_PORT ?? 3419);
const GATEWAY_PORT = Number(process.env.AUTH_UI_GATEWAY_PORT ?? 54341);
const GOTRUE_PORT = GATEWAY_PORT + 1;
const SMTP_PORT = GATEWAY_PORT + 2;
const PROD = `http://127.0.0.1:${APP_PORT}`;
const PREVIEW = `http://localhost:${APP_PORT}`;
const UNLISTED = `http://unlisted.localhost:${APP_PORT}`;
const GATEWAY = `http://127.0.0.1:${GATEWAY_PORT}`;
const GOTRUE = `http://127.0.0.1:${GOTRUE_PORT}`;

// The sandbox's team account (bootstrap.sql links it to team_members).
const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
let teamPassword = "Original-pass-1";

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function sign(claims) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  return `${head}.${createHmac("sha256", JWT_SECRET).update(head).digest("base64url")}`;
}
const far = Math.floor(Date.now() / 1000) + 24 * 3600;
const anonKey = sign({ role: "anon", iss: "supabase", exp: far });
const serviceKey = sign({ role: "service_role", iss: "supabase", exp: far });

const psql = (db, q) =>
  execFileSync(`${PG_BIN}/psql`, ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", PG_PORT, "-U", "supabase_admin", "-d", db, "-c", q]).toString().trim();

// ── SMTP sink ────────────────────────────────────────────────────────────────
const mail = [];
const smtp = net.createServer((sock) => {
  let buf = "";
  let inData = false;
  let msg = { to: [], data: "" };
  sock.write("220 sink ESMTP\r\n");
  sock.on("data", (chunk) => {
    buf += chunk.toString("latin1");
    for (;;) {
      if (inData) {
        const end = buf.indexOf("\r\n.\r\n");
        if (end < 0) return;
        msg.data = buf.slice(0, end);
        buf = buf.slice(end + 5);
        inData = false;
        mail.push({ ...msg, at: Date.now() });
        msg = { to: [], data: "" };
        sock.write("250 queued\r\n");
        continue;
      }
      const nl = buf.indexOf("\r\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") sock.write("250 sink\r\n");
      else if (cmd === "RCPT") { msg.to.push(line.replace(/^.*<|>.*$/g, "").toLowerCase()); sock.write("250 ok\r\n"); }
      else if (cmd === "DATA") { inData = true; sock.write("354 go\r\n"); }
      else if (cmd === "QUIT") { sock.end("221 bye\r\n"); return; }
      else sock.write("250 ok\r\n");
    }
  });
});
await new Promise((r) => smtp.listen(SMTP_PORT, "127.0.0.1", r));

function decodeMail(raw) {
  // Quoted-printable (gomail's default) and base64 bodies, crudely.
  const qp = raw.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const b64parts = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n(?:[^\r\n]+\r\n)*\r\n([A-Za-z0-9+/=\r\n]+)/g)].map((m) =>
    Buffer.from(m[1].replace(/\r\n/g, ""), "base64").toString("utf8"),
  );
  return [qp, ...b64parts].join("\n");
}
function linksIn(message) {
  return [...decodeMail(message.data).matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}
async function nextMailTo(email, since) {
  for (let i = 0; i < 80; i++) {
    const m = mail.find((x) => x.at >= since && x.to.includes(email.toLowerCase()));
    if (m) return m;
    await new Promise((r) => setTimeout(r, 125));
  }
  throw new Error(`no email to ${email}`);
}

// ── Supabase's gateway, reduced: /auth/v1 → GoTrue, /rest/v1 → PostgREST ───
const recoveryTemplate = readFileSync("supabase/templates/recovery.html");
const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const cors = {
    "access-control-allow-origin": req.headers.origin ?? "*",
    "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version, prefer, accept-profile, content-profile, range",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-expose-headers": "content-range, x-supabase-api-version",
  };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  if (url.pathname === "/templates/recovery.html") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(recoveryTemplate);
  }
  let upstreamBase;
  let rest;
  if (url.pathname.startsWith("/auth/v1/")) [upstreamBase, rest] = [GOTRUE, url.pathname.slice(8)];
  else if (url.pathname.startsWith("/rest/v1/")) [upstreamBase, rest] = [PGRST_URL, url.pathname.slice(8)];
  else return res.writeHead(404).end();
  const body = [];
  for await (const c of req) body.push(c);
  const headers = {};
  for (const k of ["authorization", "content-type", "prefer", "accept", "range", "accept-profile", "content-profile", "x-client-info", "x-supabase-api-version", "referer"]) {
    if (req.headers[k]) headers[k] = req.headers[k];
  }
  // Kong hands GoTrue the anon key's role when there is no user token.
  if (!headers.authorization && req.headers.apikey) headers.authorization = `Bearer ${req.headers.apikey}`;
  const upstream = await fetch(`${upstreamBase}${rest}${url.search}`, {
    method: req.method,
    headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(body),
    redirect: "manual",
  });
  const out = Buffer.from(await upstream.arrayBuffer());
  const h = { ...cors };
  for (const k of ["content-type", "content-range", "preference-applied", "location", "x-supabase-api-version"]) {
    const v = upstream.headers.get(k);
    if (v) h[k] = v;
  }
  res.writeHead(upstream.status, h);
  res.end(out);
});
await new Promise((r) => gateway.listen(GATEWAY_PORT, "127.0.0.1", r));

// ── Supabase Auth ────────────────────────────────────────────────────────────
psql("sandbox", "create database gotrue");
psql("gotrue", "create schema auth");
// Supabase runs Auth as supabase_auth_admin, whose search_path is auth.
psql("gotrue", "alter database gotrue set search_path = auth, public");
const gotrue = spawn(GOTRUE_BIN, [], {
  cwd: path.dirname(GOTRUE_MIGRATIONS),
  env: {
    PATH: process.env.PATH,
    GOTRUE_DB_DRIVER: "postgres",
    DATABASE_URL: `postgres://supabase_admin@127.0.0.1:${PG_PORT}/gotrue?sslmode=disable`,
    GOTRUE_DB_MIGRATIONS_PATH: GOTRUE_MIGRATIONS,
    GOTRUE_API_HOST: "127.0.0.1",
    PORT: String(GOTRUE_PORT),
    API_EXTERNAL_URL: `${GATEWAY}/auth/v1`,
    GOTRUE_JWT_SECRET: JWT_SECRET,
    GOTRUE_JWT_EXP: "3600",
    GOTRUE_JWT_AUD: "authenticated",
    GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
    GOTRUE_JWT_ADMIN_ROLES: "service_role",
    // The configuration docs/password-recovery.md asks for, shaped to the
    // local origins: Site URL = production, Redirect URLs = production and
    // the preview pattern.
    GOTRUE_SITE_URL: PROD,
    GOTRUE_URI_ALLOW_LIST: `${PROD}/**,${PREVIEW}/**`,
    GOTRUE_DISABLE_SIGNUP: "true",
    GOTRUE_EXTERNAL_EMAIL_ENABLED: "true",
    GOTRUE_MAILER_AUTOCONFIRM: "false",
    GOTRUE_MAILER_OTP_EXP: "3600",
    // As hosted Supabase: email links reach Auth through the gateway.
    GOTRUE_MAILER_URLPATHS_CONFIRMATION: "/auth/v1/verify",
    GOTRUE_MAILER_URLPATHS_INVITE: "/auth/v1/verify",
    GOTRUE_MAILER_URLPATHS_RECOVERY: "/auth/v1/verify",
    GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: "/auth/v1/verify",
    GOTRUE_MAILER_TEMPLATES_RECOVERY: `${GATEWAY}/templates/recovery.html`,
    GOTRUE_SMTP_HOST: "127.0.0.1",
    GOTRUE_SMTP_PORT: String(SMTP_PORT),
    GOTRUE_SMTP_ADMIN_EMAIL: "noreply@compass.test",
    GOTRUE_SMTP_SENDER_NAME: "Compass",
    GOTRUE_SMTP_MAX_FREQUENCY: "1ms",
    GOTRUE_RATE_LIMIT_EMAIL_SENT: "1000",
    GOTRUE_RATE_LIMIT_VERIFY: "1000",
    GOTRUE_RATE_LIMIT_TOKEN_REFRESH: "1000",
    GOTRUE_RATE_LIMIT_OTP: "1000",
    GOTRUE_LOG_LEVEL: "warn",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let gotrueLog = "";
gotrue.stdout.on("data", (c) => { gotrueLog = (gotrueLog + c).slice(-8000); });
gotrue.stderr.on("data", (c) => { gotrueLog = (gotrueLog + c).slice(-8000); });

const admin = (p, init = {}) =>
  fetch(`${GOTRUE}${p}`, { ...init, headers: { authorization: `Bearer ${serviceKey}`, "content-type": "application/json", ...(init.headers ?? {}) } });
// Can this email + password sign in? Straight to Supabase Auth.
async function canSignIn(email, password) {
  const r = await fetch(`${GOTRUE}/token?grant_type=password`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${anonKey}` },
    body: JSON.stringify({ email, password }),
  });
  return r.status === 200;
}
async function magicLinkTokenHash(email) {
  const r = await admin("/admin/generate_link", { method: "POST", body: JSON.stringify({ type: "magiclink", email }) });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  return j.hashed_token ?? j.properties?.hashed_token;
}

// ── The app: a production build ─────────────────────────────────────────────
const appEnv = { ...process.env, NEXT_PUBLIC_SUPABASE_URL: GATEWAY, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey, NEXT_TELEMETRY_DISABLED: "1" };
let app;
let appLog = "";
let browser;
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };

async function until(fn, label, tries = 80) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${label}`);
}

try {
  await until(async () => {
    if (gotrue.exitCode !== null) throw new Error(`auth server stopped:\n${gotrueLog}`);
    try { return (await fetch(`${GOTRUE}/health`)).ok; } catch { return false; }
  }, "auth server health", 240);

  const created = await admin("/admin/users", {
    method: "POST",
    body: JSON.stringify({ id: TEAM.id, email: TEAM.email, password: teamPassword, email_confirm: true }),
  });
  assert.equal(created.status, 200, await created.text());
  assert.ok(await canSignIn(TEAM.email, teamPassword));

  console.log("  building the app (next build)…");
  execFileSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], { env: appEnv, stdio: ["ignore", "ignore", "inherit"] });
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", String(APP_PORT)], {
    env: appEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (c) => { appLog = (appLog + c).slice(-8000); });
  app.stderr.on("data", (c) => { appLog = (appLog + c).slice(-8000); });
  await until(async () => {
    if (app.exitCode !== null) throw new Error(`next start stopped:\n${appLog}`);
    try { await fetch(`${PROD}/login`); return true; } catch { return false; }
  }, "next start", 240);

  const executablePath = process.env.CHROME_PATH;
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : { channel: process.env.CHROME_CHANNEL ?? "chrome" }),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--host-resolver-rules=MAP unlisted.localhost 127.0.0.1, MAP localhost 127.0.0.1"],
  });
  const pageErrors = [];
  async function fresh() {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    return { context, page };
  }
  const shot = async (page, name) => {
    if (!SHOTS) return;
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  };
  const signedInShell = (page) => page.getByRole("link", { name: /Compass/ }).first().waitFor({ timeout: 15000 });
  // Where a redirect sends a browser that is on `origin`.
  const locationOf = (r, origin) => new URL(r.headers.get("location"), origin).href;

  // Request a reset from `origin`'s forgot-password page; returns the link.
  async function requestReset(origin, email = TEAM.email) {
    const { context, page } = await fresh();
    await page.goto(`${origin}/login`);
    await page.getByLabel("Email").fill(email);
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await page.waitForURL(`${origin}/login/forgot-password**`);
    assert.equal(await page.getByLabel("Email").inputValue(), email, "the email carries over");
    const since = Date.now();
    await page.getByRole("button", { name: "Email me a reset link" }).click();
    await page.getByText("a link to set a new password is on its way").waitFor();
    const text = await page.locator("main, body").first().innerText();
    await context.close();
    if (email !== TEAM.email) return { text };
    const message = await nextMailTo(email, since);
    const links = linksIn(message);
    assert.equal(links.length, 1, `one link in the reset email: ${links}`);
    return { link: links[0], text };
  }
  // Open a reset link in a new, signed-out browser and set `password`.
  async function completeReset(link, password, confirm = password) {
    const { context, page } = await fresh();
    await page.goto(link);
    await page.getByRole("button", { name: "Save new password" }).waitFor();
    await page.getByLabel("New password", { exact: true }).fill(password);
    await page.getByLabel("Confirm new password").fill(confirm);
    await page.getByRole("button", { name: "Save new password" }).click();
    return { context, page };
  }
  async function signInWithPassword(origin, password) {
    const { context, page } = await fresh();
    await page.goto(`${origin}/login`);
    await page.getByLabel("Email").fill(TEAM.email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    return { context, page };
  }
  const invalidLinkNotice = async (page) => {
    await page.waitForURL(/\/login\?error=invalid_link$/);
    await page.getByText("That link is invalid, has expired or was already used.").waitFor();
    const action = page.getByRole("link", { name: "Request a new reset link" });
    assert.equal(await action.getAttribute("href"), "/login/forgot-password");
  };

  // ── 1. Login page ─────────────────────────────────────────────────────────
  {
    const { context, page } = await fresh();
    await page.goto(`${PROD}/login?error=invalid_link`);
    await invalidLinkNotice(page);
    await shot(page, "login-invalid-link");
    await page.getByRole("link", { name: "Request a new reset link" }).click();
    await page.waitForURL(`${PROD}/login/forgot-password`);
    await page.getByRole("button", { name: "Email me a reset link" }).waitFor();
    await page.goto(`${PROD}/login`);
    assert.equal(await page.getByText("That link is invalid").count(), 0, "no notice without ?error=");
    assert.equal(await page.getByRole("link", { name: "Forgot password?" }).count(), 1);
    await context.close();
    ok("login page: ?error=invalid_link explains the link and offers a new reset link");
  }

  // ── 2. Existing password sign-in ─────────────────────────────────────────
  {
    const { context, page } = await signInWithPassword(PROD, "wrong-password-1");
    await page.getByText("Invalid login credentials").waitFor();
    await context.close();
    const signed = await signInWithPassword(PROD, teamPassword);
    await signed.page.waitForURL(`${PROD}/`);
    await signedInShell(signed.page);
    ok("password sign-in still works (and still refuses a wrong password)");

    // ── 3. A normal signed-in session cannot open the reset form ───────────
    await signed.page.goto(`${PROD}/update-password`);
    await signed.page.waitForURL(`${PROD}/`);
    assert.equal(await signed.page.getByRole("button", { name: "Save new password" }).count(), 0);
    // …nor forge its way in: a made-up token opens the form (the cookie is
    // well formed) but saving asks Supabase Auth, which refuses it.
    await signed.context.addCookies([{ name: "compass_pw_reset", value: randomBytes(28).toString("hex"), url: `${PROD}/update-password` }]);
    await signed.page.goto(`${PROD}/update-password`);
    await signed.page.getByLabel("New password", { exact: true }).fill("Forged-pass-123");
    await signed.page.getByLabel("Confirm new password").fill("Forged-pass-123");
    await signed.page.getByRole("button", { name: "Save new password" }).click();
    await invalidLinkNotice(signed.page);
    assert.ok(await canSignIn(TEAM.email, teamPassword), "password unchanged");
    assert.ok(!(await canSignIn(TEAM.email, "Forged-pass-123")));
    await signed.context.close();
    ok("a normal signed-in user is sent home from /update-password; a forged token cannot change the password");
  }

  // ── 4. Existing magic-link sign-in ───────────────────────────────────────
  for (const origin of [PROD, PREVIEW]) {
    const { context, page } = await fresh();
    await page.goto(`${origin}/login`);
    await page.getByLabel("Email").fill(TEAM.email);
    const since = Date.now();
    await page.getByRole("button", { name: "Email me a magic link instead" }).click();
    await page.getByText("Check your inbox").waitFor();
    const [link] = linksIn(await nextMailTo(TEAM.email, since));
    assert.ok(link.startsWith(`${GATEWAY}/auth/v1/verify?`), link);
    assert.equal(new URL(link).searchParams.get("redirect_to"), `${origin}/auth/confirm`);
    await page.goto(link);
    await page.waitForURL(`${origin}/`);
    await signedInShell(page);
    await context.close();
    ok(`magic-link sign-in still works (${origin === PROD ? "production" : "preview"} origin)`);
  }

  // ── 5. Valid recovery, production, opened in a different browser ────────
  let spentCookie;
  let spentLink;
  {
    const { link, text } = await requestReset(PROD);
    assert.match(link, new RegExp(`^${PROD.replace(/[.:/]/g, "\\$&")}/auth/confirm\\?token_hash=(?:pkce_)?[0-9a-f]{56}&type=recovery$`), link);
    assert.match(text, /works once, on any device/);
    const unknown = await requestReset(PROD, "nobody@example.test");
    assert.equal(
      unknown.text.replace("nobody@example.test", "X"),
      text.replace(TEAM.email, "X"),
      "the confirmation reads the same for an address with no account",
    );
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!mail.some((m) => m.to.includes("nobody@example.test")), "no email for an unknown address");

    // A mail scanner fetching the link spends nothing.
    const scan = await fetch(link, { redirect: "manual" });
    assert.equal(scan.status, 307);
    assert.equal(new URL(scan.headers.get("location"), PROD).pathname, "/update-password");
    const setCookie = scan.headers.get("set-cookie");
    assert.match(setCookie, /^compass_pw_reset=(?:pkce_)?[0-9a-f]{56}; Path=\/update-password; Expires=[^;]+; Max-Age=3600; HttpOnly; SameSite=lax$/i);

    // Mismatched passwords are caught before the token is spent.
    const { context, page } = await completeReset(link, "Brand-new-pass-1", "Brand-new-pass-2");
    await page.getByText("The two passwords do not match.").waitFor();
    await shot(page, "update-password-mismatch");
    spentCookie = (await context.cookies(`${PROD}/update-password`)).find((c) => c.name === "compass_pw_reset");
    assert.ok(spentCookie, "the token is still held after a validation error");
    await page.getByLabel("New password", { exact: true }).fill("Brand-new-pass-1");
    await page.getByLabel("Confirm new password").fill("Brand-new-pass-1");
    await page.getByRole("button", { name: "Save new password" }).click();
    await page.waitForURL(`${PROD}/`);
    await signedInShell(page);
    assert.equal((await context.cookies(`${PROD}/update-password`)).filter((c) => c.name === "compass_pw_reset").length, 0, "cookie deleted");
    assert.ok(await canSignIn(TEAM.email, "Brand-new-pass-1"), "new password works");
    assert.ok(!(await canSignIn(TEAM.email, teamPassword)), "old password no longer works");
    teamPassword = "Brand-new-pass-1";
    // Signed in after the reset, the form stays shut.
    await page.goto(`${PROD}/update-password`);
    await page.waitForURL(`${PROD}/`);
    await context.close();
    spentLink = link;
    ok("valid recovery link: scanner-safe, opens in another browser, sets the password, lands in Compass");
  }

  // ── 6. The recovery state cannot be reused after the change ──────────────
  {
    const { context, page } = await fresh();
    await context.addCookies([{ name: "compass_pw_reset", value: spentCookie.value, url: `${PROD}/update-password` }]);
    await page.goto(`${PROD}/update-password`);
    await page.getByLabel("New password", { exact: true }).fill("Replayed-pass-1");
    await page.getByLabel("Confirm new password").fill("Replayed-pass-1");
    await page.getByRole("button", { name: "Save new password" }).click();
    await invalidLinkNotice(page);
    await context.close();
    const again = await completeReset(spentLink, "Replayed-pass-2");
    await invalidLinkNotice(again.page);
    await again.context.close();
    assert.ok(await canSignIn(TEAM.email, teamPassword));
    assert.ok(!(await canSignIn(TEAM.email, "Replayed-pass-1")) && !(await canSignIn(TEAM.email, "Replayed-pass-2")));
    ok("recovery state reuse after the change: the replayed cookie and the reopened link are both refused");
  }

  // ── 6b. A link in the default template's form (PKCE ?code=) ──────────────
  // Until the Reset Password template is changed, Supabase sends
  // {{ .ConfirmationURL }}: Auth's /verify, which signs the requesting
  // browser in as a recovery session. That must not stand in for the form.
  {
    const { context, page } = await fresh();
    await page.goto(`${PROD}/login/forgot-password?email=${encodeURIComponent(TEAM.email)}`);
    const since = Date.now();
    await page.getByRole("button", { name: "Email me a reset link" }).click();
    await page.getByText("a link to set a new password is on its way").waitFor();
    const tokenHash = new URL(linksIn(await nextMailTo(TEAM.email, since))[0]).searchParams.get("token_hash");
    const confirmationUrl = `${GATEWAY}/auth/v1/verify?token=${tokenHash}&type=recovery&redirect_to=${encodeURIComponent(`${PROD}/auth/confirm`)}`;
    await page.goto(confirmationUrl);
    await page.waitForURL(`${PROD}/login?error=reset_unavailable`);
    await page.getByText("That reset link could not be used here.").waitFor();
    await page.goto(`${PROD}/`);
    await page.waitForURL(`${PROD}/login`);
    await context.close();
    assert.ok(await canSignIn(TEAM.email, teamPassword));
    ok("default-template recovery link (PKCE code): the recovery session is ended, never used in place of the form");
  }

  // ── 7. Expired recovery link ─────────────────────────────────────────────
  {
    const { link } = await requestReset(PROD);
    psql("gotrue", `update auth.users set recovery_sent_at = now() - interval '2 hours' where email = '${TEAM.email}'`);
    const { context, page } = await completeReset(link, "Expired-pass-1");
    await invalidLinkNotice(page);
    await shot(page, "expired-link");
    await context.close();
    assert.ok(await canSignIn(TEAM.email, teamPassword) && !(await canSignIn(TEAM.email, "Expired-pass-1")));
    ok("expired recovery link: refused, explained, password unchanged");
  }

  // ── 8. Invalid tokens ────────────────────────────────────────────────────
  {
    // Well formed but never issued: refused by Supabase Auth on save.
    const { context, page } = await completeReset(`${PROD}/auth/confirm?token_hash=${randomBytes(28).toString("hex")}&type=recovery`, "Invalid-pass-1");
    await invalidLinkNotice(page);
    await context.close();
    // Malformed: refused before anything else.
    for (const bad of ["abc", "../../etc", `${"a".repeat(56)}%27`, ""]) {
      const r = await fetch(`${PROD}/auth/confirm?token_hash=${bad}&type=recovery`, { redirect: "manual" });
      assert.equal(locationOf(r, PROD), `${PROD}/login?error=invalid_link`, bad);
      assert.equal(r.headers.get("set-cookie"), null);
    }
    assert.ok(await canSignIn(TEAM.email, teamPassword));
    ok("invalid recovery token: refused and explained; malformed tokens never reach the form");
  }

  // ── 9. A reset that Supabase refuses (same password) ─────────────────────
  {
    const { link } = await requestReset(PROD);
    const { context, page } = await completeReset(link, teamPassword);
    await page.waitForURL(`${PROD}/login/forgot-password?error=same_password`);
    await page.getByText("Your password was not changed: the new password was the same as the old one").waitFor();
    await shot(page, "same-password");
    await page.goto(`${PROD}/`);
    await page.waitForURL(`${PROD}/login`);
    await context.close();
    ok("an update Supabase refuses is explained, the spent session is ended, a new link is offered");
  }

  // ── 10. Redirect sanitisation, end to end ────────────────────────────────
  {
    const malicious = ["https://evil.com", "//evil.com", "///evil.com", "/\\evil.com", "/%2F%2Fevil.com", "/%5Cevil.com", "/\t/evil.com", "javascript:alert(1)", "/auth/signout", "/update-password"];
    for (const next of malicious) {
      const hash = await magicLinkTokenHash(TEAM.email);
      const r = await fetch(`${PROD}/auth/confirm?token_hash=${hash}&type=magiclink&next=${encodeURIComponent(next)}`, { redirect: "manual" });
      assert.equal(r.status, 307, next);
      assert.equal(r.headers.get("location"), "/", `next=${JSON.stringify(next)}`);
    }
    const hash = await magicLinkTokenHash(TEAM.email);
    const safe = await fetch(`${PROD}/auth/confirm?token_hash=${hash}&type=magiclink&next=${encodeURIComponent("/tasks?view=mine")}`, { redirect: "manual" });
    assert.equal(safe.headers.get("location"), "/tasks?view=mine");
    for (const next of ["https://evil.com", "//evil.com"]) {
      const r = await fetch(`${PROD}/auth/confirm?code=not-a-code&next=${encodeURIComponent(next)}`, { redirect: "manual" });
      assert.equal(r.headers.get("location"), "/login?error=invalid_link");
    }
    ok("external and protocol-relative next values never leave the origin (verified sign-in and failed link)");
  }

  // ── 11. Preview deployment origin ────────────────────────────────────────
  {
    const { link } = await requestReset(PREVIEW);
    assert.ok(link.startsWith(`${PREVIEW}/auth/confirm?token_hash=`), `reset link returns to the preview: ${link}`);
    const { context, page } = await completeReset(link, "Preview-pass-1");
    await page.waitForURL(`${PREVIEW}/`);
    await signedInShell(page);
    await context.close();
    assert.ok(await canSignIn(TEAM.email, "Preview-pass-1"));
    teamPassword = "Preview-pass-1";
    ok("preview origin: the reset link returns to the preview and completes there");
  }

  // ── 12. An origin missing from Redirect URLs falls back to the Site URL ──
  {
    const { link } = await requestReset(UNLISTED);
    assert.ok(link.startsWith(`${PROD}?token_hash=`), `falls back to the Site URL: ${link}`);
    const { context, page } = await completeReset(link, "Fallback-pass-1");
    await page.waitForURL(`${PROD}/`);
    await signedInShell(page);
    await context.close();
    teamPassword = "Fallback-pass-1";
    assert.ok(await canSignIn(TEAM.email, teamPassword));
    ok("unlisted origin: Supabase falls back to the Site URL and the proxy still completes the reset on production");
  }

  // Password sign-in once more, with the final password, on the preview.
  {
    const { context, page } = await signInWithPassword(PREVIEW, teamPassword);
    await page.waitForURL(`${PREVIEW}/`);
    await signedInShell(page);
    await context.close();
    ok("password sign-in with the reset password (preview origin)");
  }

  assert.deepEqual(pageErrors, [], "no uncaught page errors");
  console.log(`\n${checks.length} auth flow checks passed`);
} catch (e) {
  console.error(e);
  console.error("\n--- app log ---\n", appLog.slice(-3000));
  console.error("\n--- auth log ---\n", gotrueLog.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  app?.kill();
  gotrue.kill();
  gateway.close();
  smtp.close();
}
