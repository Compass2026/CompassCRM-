// stripe-reconcile (B4): the request boundary, the engine's failure handling
// and the Stripe client's pagination and retries, over a fake Stripe and an
// in-memory store. The real database: tests/stripe-reconcile-integration.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStripeReconcile, sameSecret } from "../supabase/functions/stripe-reconcile/handler.ts";
import { clientStatus, diffFingerprints, mapLimit, runStatus } from "../supabase/functions/stripe-reconcile/engine.ts";
import { createStripeApi, retryDelayMs, StripeApiError } from "../supabase/functions/_shared/stripe/api.ts";
import { fakeStripe, seedCustomer } from "./fixtures/stripe-fake.mjs";

const A = "00000000-0000-4000-b000-00000000000a";
const B = "00000000-0000-4000-b000-00000000000b";
const C = "00000000-0000-4000-b000-00000000000c";
const ADMIN = "00000000-0000-4000-a000-0000000000ad";
const SECRET = "recon-secret";

function memoryStore({ live = false, links = [] } = {}) {
  const st = {
    runs: [], results: [], applied: [], events: [], running: false,
    fp: new Map(), // client → fingerprint
    callers: new Map([
      ["admin", { kind: "team", memberId: ADMIN, role: "admin" }],
      ["member", { kind: "team", memberId: "m", role: "member" }],
      ["portal", { kind: "portal", portalUserId: "p", clientId: A }],
      ["stranger", null],
    ]),
    links,
    failApply: new Set(), // customer ids whose writes fail
  };
  return {
    st,
    async caller(jwt) { return st.callers.has(jwt) ? st.callers.get(jwt) : "none"; },
    async secret(name) { return name === "BILLING_RECONCILE_SECRET" ? SECRET : null; },
    async billingLivemode() { return live; },
    async client(id) { return [A, B, C].includes(id) ? { id, name: id, status: "active" } : null; },
    async activeLink(id) { const l = st.links.find((x) => x.client_id === id); return l ? { stripe_customer_id: l.stripe_customer_id } : null; },
    async apply(ops) {
      for (const o of ops) {
        const cus = o.row?.stripe_customer_id ?? o.id;
        if (st.failApply.has(cus)) throw new Error("billing_sync_apply: constraint failed");
      }
      st.applied.push(...ops);
      return ops.map((o) => ({ op: o.op, id: o.row?.stripe_invoice_id ?? o.row?.stripe_subscription_id ?? o.row?.stripe_customer_id ?? o.id ?? null, result: "written" }));
    },
    async linkCustomer() {},
    async beginEvent() { return { claimed: true, attempt: 1 }; },
    async finishEvent() { return { ok: true }; },
    async failEvent() { return { ok: true }; },
    async beginRun(p) {
      if (st.running) { const e = new Error("running"); e.code = "55P03"; Object.setPrototypeOf(e, (await import("../supabase/functions/stripe-billing/store.ts")).BillingDbError.prototype); throw e; }
      st.running = true;
      const id = `run-${st.runs.length + 1}`;
      st.runs.push({ id, ...p, status: "running" });
      return { id };
    },
    async recordClient(p) { st.results.push(p); },
    async finishRun(p) { Object.assign(st.runs.find((r) => r.id === p.run_id), p); st.running = false; },
    async fingerprint(client) { return st.fp.get(client) ?? {}; },
    async catalogFingerprint() { return {}; },
    async linkedCustomers(_live, clientId) { return st.links.filter((l) => !clientId || l.client_id === clientId); },
    async mappedProducts() { return []; },
    async catalogWarnings() { return []; },
    async recoverableEvents() { return st.events; },
    async mirrorInvoiceIds() { return []; },
    async pendingCheckouts() { return []; },
    async attention() { return []; },
  };
}

function setup({ live = false, key = "sk_test_x", links, stripe } = {}) {
  const s = stripe ?? fakeStripe({ mode: key.includes("_live_") ? "live" : "test" });
  const store = memoryStore({ live, links: links ?? [] });
  const jobs = [];
  const fn = createStripeReconcile({
    config: async () => ({ secretKey: key }), store, makeApi: () => s.api, waitUntil: (p) => jobs.push(p),
  });
  const call = async (headers, body = {}) => {
    const r = await fn.handle(new Request("http://x/stripe-reconcile", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  return { s, store, jobs, call, settle: () => Promise.all(jobs.splice(0)) };
}
const bearer = (who) => ({ authorization: `Bearer ${who}` });

// ── Pure rules ───────────────────────────────────────────────────────────────
test("diff: imported, updated and removed objects by category; identical fingerprints are no change", () => {
  const before = { subscription: { sub_1: "a" }, invoice: { in_1: "x", in_old: "y" }, customer: { cus_1: "c" } };
  const after = { subscription: { sub_1: "b" }, invoice: { in_1: "x", in_2: "z" }, customer: { cus_1: "c" }, refund: { re_1: "r" } };
  const d = diffFingerprints(before, after);
  assert.deepEqual(d.changes, { subscription_updated: 1, invoice_imported: 1, invoice_removed: 1, refund_imported: 1 });
  assert.equal(d.total, 4);
  assert.deepEqual(diffFingerprints(after, after), { changes: {}, total: 0 });
  assert.deepEqual(diffFingerprints({ price: { p: "1" } }, { price: { p: "2" }, product: { q: "3" } }).changes,
    { catalog_price_updated: 1, catalog_product_imported: 1 });
});

test("statuses: failed > attention > repaired > healthy; run completed / with errors / partial", () => {
  assert.equal(clientStatus({ error: "x", changed: 3, attention: ["past_due"] }), "failed");
  assert.equal(clientStatus({ error: null, changed: 3, attention: ["package_mismatch"] }), "attention");
  assert.equal(clientStatus({ error: null, changed: 0, attention: [], warnings: ["customer_deleted_in_stripe"] }), "attention");
  assert.equal(clientStatus({ error: null, changed: 2, attention: [] }), "repaired");
  assert.equal(clientStatus({ error: null, changed: 0, attention: [] }), "healthy");
  assert.equal(runStatus({ failures: 0, skipped: 0 }), "completed");
  assert.equal(runStatus({ failures: 1, skipped: 4 }), "completed_with_errors");
  assert.equal(runStatus({ failures: 0, skipped: 4 }), "partial");
});

test("mapLimit: bounded concurrency, and the first error stops new work after started items finish", async () => {
  let active = 0, peak = 0;
  const done = [];
  await mapLimit([1, 2, 3, 4, 5], 2, async (n) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); done.push(n); active--; });
  assert.equal(peak, 2);
  assert.deepEqual(done.sort(), [1, 2, 3, 4, 5]);
  const seen = [];
  await assert.rejects(mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    seen.push(n);
    await new Promise((r) => setTimeout(r, n === 1 ? 1 : 10));
    if (n === 1) throw new Error("boom");
  }), /boom/);
  assert.ok(seen.length <= 3, `no new work after the error: ${seen}`);
});

test("the scheduler's secret is compared exactly", () => {
  assert.equal(sameSecret("abc", "abc"), true);
  assert.equal(sameSecret("abc", "abd"), false);
  assert.equal(sameSecret("abc", "abcd"), false);
  assert.equal(sameSecret("", ""), false);
  assert.equal(sameSecret(null, "abc"), false);
});

// ── The Stripe client: pagination and retries ───────────────────────────────
function fakeFetch(script) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const step = script(calls.length, url, init);
    if (step instanceof Error) throw step;
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status ?? 200, headers: step.headers ?? {} });
  };
  return { f, calls };
}

test("pagination: every page of a list is read (250 invoices across three pages)", async () => {
  const all = Array.from({ length: 250 }, (_, i) => ({ id: `in_${String(i).padStart(3, "0")}` }));
  const { f, calls } = fakeFetch((_n, url) => {
    const after = new URL(url).searchParams.get("starting_after");
    const start = after ? all.findIndex((x) => x.id === after) + 1 : 0;
    const page = all.slice(start, start + 100);
    return { body: { data: page, has_more: start + 100 < all.length } };
  });
  const api = createStripeApi({ secretKey: "sk_test_x", fetch: f });
  const got = await api.list("/v1/invoices", { customer: "cus_1" });
  assert.equal(got.length, 250);
  assert.equal(new Set(got.map((x) => x.id)).size, 250);
  assert.equal(calls.length, 3);
});

test("retries: 429 honours Retry-After, 5xx backs off, then success; a persistent failure surfaces", async () => {
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  let r = fakeFetch((n) => n === 1 ? { status: 429, headers: { "retry-after": "2" }, body: { error: { message: "rate" } } } : n === 2 ? { status: 503, body: {} } : { body: { id: "cus_1" } });
  let api = createStripeApi({ secretKey: "sk_test_x", fetch: r.f, retry: { sleep, baseDelayMs: 100 } });
  assert.equal((await api.get("/v1/customers/cus_1")).id, "cus_1");
  assert.equal(r.calls.length, 3);
  assert.equal(slept[0], 2000);
  assert.ok(slept[1] >= 200 && slept[1] < 300, `backoff ${slept[1]}`);

  r = fakeFetch(() => ({ status: 500, body: { error: { message: "down" } } }));
  api = createStripeApi({ secretKey: "sk_test_x", fetch: r.f, retry: { sleep } });
  await assert.rejects(api.get("/v1/customers/cus_1"), (e) => e instanceof StripeApiError && e.status === 500);
  assert.equal(r.calls.length, 3, "two retries, then the error");

  r = fakeFetch((n) => n === 1 ? new TypeError("fetch failed") : { body: { id: "x" } });
  api = createStripeApi({ secretKey: "sk_test_x", fetch: r.f, retry: { sleep } });
  assert.equal((await api.get("/v1/x")).id, "x");

  r = fakeFetch(() => ({ status: 409, headers: { "stripe-should-retry": "false" }, body: {} }));
  api = createStripeApi({ secretKey: "sk_test_x", fetch: r.f, retry: { sleep } });
  await assert.rejects(api.get("/v1/x"));
  assert.equal(r.calls.length, 1, "Stripe said not to retry");

  r = fakeFetch(() => ({ status: 401, body: { error: { type: "authentication_error" } } }));
  api = createStripeApi({ secretKey: "sk_test_x", fetch: r.f, retry: { sleep } });
  await assert.rejects(api.get("/v1/x"), (e) => e.status === 401);
  assert.equal(r.calls.length, 1, "an authentication failure is never retried");
});

test("retries: a create is retried only with an idempotency key", async () => {
  const sleep = async () => {};
  let r = fakeFetch((n) => n === 1 ? { status: 500, body: {} } : { body: { id: "bps_1" } });
  let api = createStripeApi({ secretKey: "sk_test_x", fetch: r.f, retry: { sleep } });
  await assert.rejects(api.post("/v1/billing_portal/sessions", { customer: "cus_1" }));
  assert.equal(r.calls.length, 1);
  r = fakeFetch((n) => n === 1 ? { status: 500, body: {} } : { body: { id: "cus_1" } });
  api = createStripeApi({ secretKey: "sk_test_x", fetch: r.f, retry: { sleep } });
  assert.equal((await api.post("/v1/customers", { email: "a@b.c" }, { idempotencyKey: "k1" })).id, "cus_1");
  assert.equal(r.calls[1].init.headers["idempotency-key"], "k1");
  assert.ok(retryDelayMs(10, null) <= 10_000, "capped");
});

// ── Authorization ────────────────────────────────────────────────────────────
test("authorization: anon, a bad secret, a member, a portal contact and a stranger are refused before Stripe is called", async () => {
  const t = setup();
  assert.equal((await t.call({})).status, 401);
  assert.equal((await t.call({ "x-billing-reconcile-secret": "wrong" })).status, 401);
  assert.equal((await t.call(bearer("member"))).body.error, "admin_only");
  assert.equal((await t.call(bearer("portal"))).status, 403);
  assert.equal((await t.call(bearer("stranger"))).status, 403);
  assert.equal((await t.call({ "x-billing-reconcile-secret": SECRET }, { client_id: A })).status, 400, "the scheduler runs agency-wide");
  assert.deepEqual(t.s.calls, []);
  assert.equal(t.store.st.runs.length, 0);
  const get = await (createStripeReconcile({ config: async () => null, store: t.store, makeApi: () => t.s.api })).handle(new Request("http://x", { method: "GET" }));
  assert.equal(get.status, 405);
});

test("the scheduler and an admin start the same engine; one run at a time", async () => {
  const t = setup();
  const sched = await t.call({ "x-billing-reconcile-secret": SECRET });
  assert.equal(sched.status, 202);
  assert.equal(sched.body.trigger, "schedule");
  assert.equal(t.store.st.runs[0].requested_by, null);
  await t.settle();
  t.store.st.running = true; // a run in progress (0061 enforces one per mode)
  assert.equal((await t.call(bearer("admin"))).status, 409, "a second run waits for the first");
  t.store.st.running = false;
  assert.equal(t.store.st.runs[0].status, "completed");
  const adm = await t.call(bearer("admin"));
  assert.equal(adm.status, 202);
  assert.equal(t.store.st.runs[1].requested_by, ADMIN);
  await t.settle();
  assert.equal((await t.call(bearer("admin"), { client_id: C })).body.error, "no_customer");
});

test("mode: a live key is refused until billing is live, a test key once it is", async () => {
  assert.equal((await setup({ key: "sk_live_x" }).call({ "x-billing-reconcile-secret": SECRET })).body.error, "live_mode_not_enabled");
  assert.equal((await setup({ live: true }).call({ "x-billing-reconcile-secret": SECRET })).body.error, "key_mode_mismatch");
});

// ── Failure handling ─────────────────────────────────────────────────────────
function seeded() {
  const s = fakeStripe();
  seedCustomer(s, { cus: "cus_A", sub: "sub_A", inv: "in_A", pi: "pi_A", py: "py_A", prefix: "A" });
  seedCustomer(s, { cus: "cus_B", sub: "sub_B", inv: "in_B", pi: "pi_B", py: "py_B", prefix: "B" });
  seedCustomer(s, { cus: "cus_C", sub: "sub_C", inv: "in_C", pi: "pi_C", py: "py_C", prefix: "C" });
  return s;
}
const LINKS = [{ client_id: A, stripe_customer_id: "cus_A" }, { client_id: B, stripe_customer_id: "cus_B" }, { client_id: C, stripe_customer_id: "cus_C" }];

test("one customer failing does not stop the others; the run ends completed_with_errors", async () => {
  const t = setup({ stripe: seeded(), links: LINKS });
  t.store.st.failApply.add("cus_B");
  await t.call({ "x-billing-reconcile-secret": SECRET });
  await t.settle();
  const run = t.store.st.runs[0];
  assert.equal(run.status, "completed_with_errors");
  assert.equal(run.failures, 1);
  assert.deepEqual(t.store.st.results.map((r) => [r.client_id, r.status]).sort(), [[A, "healthy"], [B, "failed"], [C, "healthy"]].sort());
  assert.match(t.store.st.results.find((r) => r.client_id === B).error, /constraint failed/);
});

test("a Stripe authentication failure fails the run at once, before any customer", async () => {
  const s = seeded();
  s.api.get = async (path) => { throw new StripeApiError(401, { error: { type: "authentication_error", message: "Invalid API Key" } }, path); };
  const t = setup({ stripe: s, links: LINKS });
  await t.call({ "x-billing-reconcile-secret": SECRET });
  await t.settle();
  assert.equal(t.store.st.runs[0].status, "failed");
  assert.match(t.store.st.runs[0].error, /Stripe refused the key \(401\)/);
  assert.equal(t.store.st.results.length, 0);
});

test("three customers failing in a row is systemic: the run fails and says so", async () => {
  const links = [...LINKS, { client_id: "00000000-0000-4000-b000-00000000000d", stripe_customer_id: "cus_D" }];
  const t = setup({ stripe: seeded(), links });
  for (const c of ["cus_A", "cus_B", "cus_C"]) t.store.st.failApply.add(c);
  await t.call({ "x-billing-reconcile-secret": SECRET });
  await t.settle();
  assert.equal(t.store.st.runs[0].status, "failed");
  assert.match(t.store.st.runs[0].error, /Three customers failed in a row/);
});

test("a run over its time budget stops cleanly as partial; the rest is left for the next run", async () => {
  const s = seeded();
  let clock = Date.parse("2026-09-30T07:00:00Z");
  const store = memoryStore({ links: LINKS });
  const origResync = store.fingerprint;
  store.fingerprint = async (c) => { clock += 60_000; return origResync(c); };
  const jobs = [];
  const fn = createStripeReconcile({ config: async () => ({ secretKey: "sk_test_x" }), store, makeApi: () => s.api,
    waitUntil: (p) => jobs.push(p), now: () => new Date(clock), budgetMs: 150_000, concurrency: 1 });
  await fn.handle(new Request("http://x", { method: "POST", headers: { "x-billing-reconcile-secret": SECRET }, body: "{}" }));
  await Promise.all(jobs);
  assert.equal(store.st.runs[0].status, "partial");
  assert.equal(store.st.results.length, 2);
  assert.equal(store.st.runs[0].summary.skipped, 1);
});
