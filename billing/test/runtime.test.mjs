// The billing runtime's own edges (the handlers and the store are exercised
// end to end by `npm run test:billing-runtime` at the repository root):
// the Stripe key rules, the Node → Fetch adapter, and the built endpoints'
// refusals before anything reaches the database or Stripe.
//   cd billing && npm run build && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { appBaseUrl, nodeEntry, sameSecret, stripeKey } from "../src/runtime.ts";

const require = createRequire(import.meta.url);

function setEnv(vars) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  return () => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
}
// Runs fn (sync or async) with the variables set, and restores them after.
function withEnv(vars, fn) {
  const restore = setEnv(vars);
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === "function") return out.finally(restore);
  restore();
  return out;
}

test("a test key is used; a live key only with BILLING_ALLOW_LIVE=true; anything else is no key", () => {
  withEnv({ STRIPE_SECRET_KEY: "sk_test_abc", BILLING_ALLOW_LIVE: undefined }, () => assert.equal(stripeKey(), "sk_test_abc"));
  withEnv({ STRIPE_SECRET_KEY: "rk_test_abc", BILLING_ALLOW_LIVE: undefined }, () => assert.equal(stripeKey(), "rk_test_abc"));
  withEnv({ STRIPE_SECRET_KEY: "sk_live_abc", BILLING_ALLOW_LIVE: undefined }, () => assert.equal(stripeKey(), null));
  withEnv({ STRIPE_SECRET_KEY: "sk_live_abc", BILLING_ALLOW_LIVE: "yes" }, () => assert.equal(stripeKey(), null));
  withEnv({ STRIPE_SECRET_KEY: "sk_live_abc", BILLING_ALLOW_LIVE: "true" }, () => assert.equal(stripeKey(), "sk_live_abc"));
  withEnv({ STRIPE_SECRET_KEY: "pk_test_abc" }, () => assert.equal(stripeKey(), null));
  withEnv({ STRIPE_SECRET_KEY: undefined }, () => assert.equal(stripeKey(), null));
});

test("return links: APP_BASE_URL when it is an https origin, the CRM otherwise", () => {
  withEnv({ APP_BASE_URL: "https://crm.example.com/" }, () => assert.equal(appBaseUrl(), "https://crm.example.com"));
  withEnv({ APP_BASE_URL: "http://crm.example.com" }, () => assert.equal(appBaseUrl(), "https://compass-crm-ten.vercel.app"));
  withEnv({ APP_BASE_URL: "https://crm.example.com/path" }, () => assert.equal(appBaseUrl(), "https://compass-crm-ten.vercel.app"));
  withEnv({ APP_BASE_URL: undefined }, () => assert.equal(appBaseUrl(), "https://compass-crm-ten.vercel.app"));
});

test("constant-time secret comparison", () => {
  assert.equal(sameSecret("abc", "abc"), true);
  assert.equal(sameSecret("abc", "abd"), false);
  assert.equal(sameSecret("abc", "abcd"), false);
  assert.equal(sameSecret("", ""), false);
  assert.equal(sameSecret(null, "x"), false);
});

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test("the adapter passes the raw body and headers through, and the handler's answer back", async () => {
  let seen;
  const s = await serve(nodeEntry(async (req) => {
    seen = { method: req.method, sig: req.headers.get("stripe-signature"), body: await req.text(), path: new URL(req.url).pathname };
    return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "content-type": "application/json", "x-answer": "1" } });
  }));
  try {
    const raw = '{"id":"evt_1",  "unicode":"é—✓"}';
    const res = await fetch(`${s.url}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": "t=1,v1=x" }, body: raw });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("x-answer"), "1");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(seen, { method: "POST", sig: "t=1,v1=x", body: raw, path: "/api/stripe/webhook" });
  } finally { await s.close(); }
});

test("background work is awaited before answering when the platform gives no waitUntil", async () => {
  let done = false;
  const s = await serve(nodeEntry(async (_req, work) => {
    work.waitUntil(new Promise((r) => setTimeout(() => { done = true; r(); }, 50)));
    return new Response("{}", { status: 202 });
  }));
  try {
    const res = await fetch(s.url, { method: "POST", body: "{}" });
    assert.equal(res.status, 202);
    assert.equal(done, true);
  } finally { await s.close(); }
});

test("an unexpected error is a 500 with no detail", async () => {
  const s = await serve(nodeEntry(async () => { throw new Error("secret detail"); }));
  try {
    const res = await fetch(s.url, { method: "POST", body: "{}" });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "failed" });
  } finally { await s.close(); }
});

// The built functions (npm run build), as Vercel's Node launcher loads them.
const BASE_ENV = {
  BILLING_DATABASE_URL: "postgres://billing_sync:unused@127.0.0.1:9/none",
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_ANON_KEY: "anon",
};
function built(path) {
  const m = require(`../.vercel/output/functions/${path}.func/index.js`);
  return m.default ?? m;
}

test("webhook: not configured without both Stripe secrets; a bad signature is refused before the database", async () => {
  const s = await serve((req, res) => built("api/stripe/webhook")(req, res));
  try {
    await withEnv({ ...BASE_ENV, STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: undefined }, async () => {
      const r = await fetch(s.url, { method: "POST", body: "{}" });
      assert.equal(r.status, 503);
      assert.deepEqual(await r.json(), { error: "stripe_not_configured" });
    });
    await withEnv({ ...BASE_ENV, STRIPE_SECRET_KEY: "sk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x", BILLING_ALLOW_LIVE: undefined }, async () => {
      const r = await fetch(s.url, { method: "POST", body: "{}" });
      assert.equal(r.status, 503, "a live key is not configured until BILLING_ALLOW_LIVE");
    });
    await withEnv({ ...BASE_ENV, STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" }, async () => {
      const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
      const t = Math.floor(Date.now() / 1000);
      const wrong = createHmac("sha256", "whsec_other").update(`${t}.${body}`).digest("hex");
      const r = await fetch(s.url, { method: "POST", headers: { "stripe-signature": `t=${t},v1=${wrong}` }, body });
      assert.equal(r.status, 400);
      assert.equal((await r.json()).error, "invalid_signature");
      const g = await fetch(s.url);
      assert.equal(g.status, 405);
    });
  } finally { await s.close(); }
});

test("billing: no JWT is not signed in, before the database or Stripe", async () => {
  const s = await serve((req, res) => built("api/billing")(req, res));
  try {
    await withEnv({ ...BASE_ENV, STRIPE_SECRET_KEY: "sk_test_x" }, async () => {
      const r = await fetch(s.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "search_customers", query: "ab" }) });
      assert.equal(r.status, 401);
      assert.equal((await r.json()).error, "not_signed_in");
    });
  } finally { await s.close(); }
});

test("reconcile: the cron needs CRON_SECRET as its bearer; nobody can post the scheduler header", async () => {
  const s = await serve((req, res) => built("api/reconcile")(req, res));
  try {
    await withEnv({ ...BASE_ENV, STRIPE_SECRET_KEY: "sk_test_x", CRON_SECRET: "cron-secret-value" }, async () => {
      assert.equal((await fetch(s.url)).status, 401, "no bearer");
      assert.equal((await fetch(s.url, { headers: { authorization: "Bearer wrong" } })).status, 401, "wrong bearer");
      const r = await fetch(s.url, { method: "POST", headers: { "x-billing-reconcile-secret": "cron-secret-value" }, body: "{}" });
      assert.equal(r.status, 401, "the scheduler header is accepted only from the cron route");
      const anon = await fetch(s.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(anon.status, 401);
      assert.equal((await anon.json()).error, "not_signed_in");
    });
    await withEnv({ ...BASE_ENV, STRIPE_SECRET_KEY: "sk_test_x", CRON_SECRET: undefined }, async () => {
      assert.equal((await fetch(s.url, { headers: { authorization: "Bearer " } })).status, 401, "no CRON_SECRET, no cron");
    });
  } finally { await s.close(); }
});
