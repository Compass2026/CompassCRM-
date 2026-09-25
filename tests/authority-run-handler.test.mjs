// authority-run (Authority D2) request boundary over a fake store: callers,
// modes, the run lock, refresh without an inventory, completed / degraded /
// failed, background exceptions, and the payload authority_record_run gets.
// End to end against PostgREST + the sandbox replay: tests/authority-integration.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthorityRun, MODES } from "../supabase/functions/authority-run/handler.ts";
import { classifyRun, inputHash, validatePayload, safeError, canonical, isErrorPage, DEGRADED_ERROR_SHARE } from "../supabase/functions/authority-run/classify.ts";
import { lucasAuthority, SITE, page } from "./fixtures/authority-lucas.mjs";

const CLIENT = "102d3b20-2795-44ae-bd64-d1e43916291c";
const MEMBER = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const FP = { intelligence: "a", page_groups: "b", keywords: "c", gsc: "2026-09-22:825", ranks: "none", posts: "d", content: "e", change_log: "f", site: "g" };

const siteInput = () => { const i = lucasAuthority(); const inv = i.authority.inventory; i.authority.inventory = null; delete i.authority.places; return { i, inv }; };
const invFrom = (pages, over = {}) => ({ fetched_at: "2026-09-25T20:00:00Z", site: SITE, pages, sitemap_urls: pages.length, refused: [], refusals: [], budget_exceeded: false, skipped: 0, ...over });

function fakeStore(over = {}) {
  const calls = { begin: [], record: [], order: [] };
  const { i } = siteInput();
  const store = {
    secret: async (n) => (n === "SYNC_CRON_SECRET" ? "cron-secret" : null),
    caller: async (jwt) => (jwt === "team-jwt" ? { member: MEMBER } : jwt === "portal-jwt" ? { member: null } : "none"),
    client: async (id) => (id === CLIENT ? { id, status: "active" } : null),
    latestInventory: async () => null,
    begin: async (...a) => { calls.begin.push(a); return { run_id: RUN }; },
    fingerprint: async () => { calls.order.push("fingerprint"); return FP; },
    input: async () => { calls.order.push("input"); return structuredClone(i); },
    record: async (id, p) => { calls.record.push({ id, p }); return { run_id: id, status: p.status }; },
    ...over,
  };
  return { store, calls };
}

function harness({ store, inventory, gazetteer = { MO: ["Saint Louis", "Kirkwood"] }, resolve = async () => ["93.184.216.34"] } = {}) {
  const jobs = [];
  const pages = siteInput().inv.pages;
  const run = createAuthorityRun({
    store, gazetteer, resolve,
    inventory: inventory ?? (async () => invFrom(pages)),
    waitUntil: (p) => jobs.push(p),
  });
  const call = async (body, headers = { "x-cron-secret": "cron-secret" }) => {
    const r = await run.handle(new Request("http://x/authority-run", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  return { call, settle: () => Promise.all(jobs), jobs };
}

test("callers: the worker's cron secret or a team member; nobody else", async () => {
  const { store, calls } = fakeStore();
  const { call } = harness({ store });
  assert.equal((await call({ mode: "version" }, {})).status, 401);
  assert.equal((await call({ mode: "version" }, { "x-cron-secret": "wrong" })).status, 403);
  assert.equal((await call({ mode: "version" }, { Authorization: "Bearer anon-key" })).status, 403);
  assert.equal((await call({ mode: "version" }, { Authorization: "Bearer portal-jwt" })).status, 403, "signed in but not on the team");
  assert.equal((await call({ mode: "full", client_id: CLIENT }, { Authorization: "Bearer portal-jwt" })).status, 403);
  assert.equal(calls.begin.length, 0, "a refused caller never starts a run");
  assert.equal((await call({ mode: "version" }, { Authorization: "Bearer team-jwt" })).status, 200);
  const r = await call({ mode: "full", client_id: CLIENT }, { Authorization: "Bearer team-jwt" });
  assert.equal(r.status, 202);
  assert.deepEqual(calls.begin[0], [CLIENT, "full", "team", MEMBER]);
  await call({ mode: "full", client_id: CLIENT });
  assert.deepEqual(calls.begin[1], [CLIENT, "full", "worker", null]);
});

test("version: the engine, modes, limits and whether DNS works here", async () => {
  const { call } = harness({ store: fakeStore().store });
  const v = await call({ mode: "version" });
  assert.equal(v.status, 200);
  assert.equal(v.body.engine, "authority-v1.1");
  assert.deepEqual(v.body.modes, [...MODES]);
  assert.deepEqual(v.body.limits, { maxPages: 150, concurrency: 4, timeoutMs: 20000, budgetMs: 120000, maxBytes: 2000000, textChars: 4000 });
  assert.equal(v.body.dns, true);
  const { call: noDns } = harness({ store: fakeStore().store, resolve: null });
  assert.equal((await noDns({ mode: "version" })).body.dns, false);
  const { call: badDns } = harness({ store: fakeStore().store, resolve: async () => { throw new Error("SERVFAIL"); } });
  assert.equal((await badDns({ mode: "version" })).body.dns, false);
});

test("body validation: modes, client id, unknown fields, unknown and offboarded clients", async () => {
  const { store, calls } = fakeStore({ client: async (id) => (id === CLIENT ? { id, status: "offboarded" } : null) });
  const { call } = harness({ store });
  for (const mode of ["status", "next", "publish", "approve", undefined]) assert.equal((await call({ mode, client_id: CLIENT })).status, 400, String(mode));
  assert.equal((await call({ mode: "full" })).status, 400);
  assert.equal((await call({ mode: "full", client_id: "lucas" })).status, 400);
  assert.equal((await call({ mode: "full", client_id: CLIENT, inventory: {} })).status, 400, "a caller cannot hand in an inventory");
  assert.equal((await call({ mode: "full", client_id: CLIENT, report: {} })).status, 400, "or a report");
  assert.equal((await call({ mode: "full", client_id: "33333333-3333-4333-8333-333333333333" })).status, 404);
  assert.equal((await call({ mode: "full", client_id: CLIENT })).body.error, "client_offboarded");
  const r = await (await harness({ store }).call)("not json");
  assert.equal(r.status, 400);
  assert.equal(calls.begin.length, 0);
});

test("the run lock: a run already running is a 409 with its id, and nothing runs in the background", async () => {
  const { store } = fakeStore({ begin: async () => ({ conflict: true, running_run_id: RUN }) });
  const { call, jobs } = harness({ store });
  const r = await call({ mode: "full", client_id: CLIENT });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: "run_in_progress", run_id: RUN });
  assert.equal(jobs.length, 0);
});

test("refresh without a completed run (or with one of another site) needs a full run first", async () => {
  const { store, calls } = fakeStore();
  const { call } = harness({ store });
  const r = await call({ mode: "refresh", client_id: CLIENT });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "needs_full_run");
  const other = fakeStore({ latestInventory: async () => ({ run_id: RUN, inventory: invFrom([], { site: "https://someone-else.example" }) }) });
  assert.equal((await harness({ store: other.store }).call({ mode: "refresh", client_id: CLIENT })).body.error, "needs_full_run");
  const none = fakeStore({ latestInventory: async () => ({ run_id: RUN, inventory: null }) });
  assert.equal((await harness({ store: none.store }).call({ mode: "refresh", client_id: CLIENT })).body.error, "needs_full_run");
  assert.equal(calls.begin.length + other.calls.begin.length + none.calls.begin.length, 0);
});

test("full: 202 {run_id}, fingerprint before input, then one completed record with the payload 0048 validates", async () => {
  const { store, calls } = fakeStore();
  let invCalls = 0;
  const { call, settle } = harness({ store, inventory: async (opts) => { invCalls++; assert.equal(opts.site, SITE); assert.equal(opts.concurrency, 4); assert.equal(opts.maxPages, 150); assert.equal(opts.timeoutMs, 20000); assert.equal(opts.budgetMs, 120000); assert.ok(opts.candidates.length > 0); return invFrom(siteInput().inv.pages); } });
  const r = await call({ mode: "full", client_id: CLIENT });
  assert.equal(r.status, 202);
  assert.deepEqual(r.body, { run_id: RUN, mode: "full", status: "running" });
  await settle();
  assert.deepEqual(calls.order, ["fingerprint", "input"]);
  assert.equal(invCalls, 1);
  assert.equal(calls.record.length, 1);
  const { id, p } = calls.record[0];
  assert.equal(id, RUN);
  assert.equal(p.status, "completed", JSON.stringify(p.inventory?.health));
  assert.equal(p.engine_version, "authority-v1.1");
  assert.match(p.input_hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(p.section_hashes, FP);
  assert.equal(p.report.client.id, CLIENT);
  assert.equal(p.as_of, p.report.as_of);
  assert.equal(p.judged_at, p.report.generated_at);
  assert.equal(validatePayload(p, CLIENT), null);
  const keys = p.report.opportunities.map((o) => o.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(p.inventory.pages.length, siteInput().inv.pages.length);
  assert.equal(p.inventory.health.status, "completed");
  assert.equal(p.report.inventory.fetched_at, "2026-09-25T20:00:00Z");
  assert.deepEqual(Object.keys(p).sort(), ["as_of", "engine_version", "input_hash", "inventory", "inventory_errors", "judged_at", "report", "section_hashes", "status"]);
});

test("full with the site down is degraded (stored, no opportunity changes are asked for)", async () => {
  const { store, calls } = fakeStore();
  const down = siteInput().inv.pages.map((p) => ({ ...p, status: null, final_url: null, final_status: null }));
  const { call, settle } = harness({ store, inventory: async () => invFrom(down) });
  await call({ mode: "full", client_id: CLIENT });
  await settle();
  const { p } = calls.record[0];
  assert.equal(p.status, "degraded");
  assert.equal(p.inventory_errors, down.length);
  assert.ok(p.inventory.health.reasons.some((x) => /home page/.test(x)));
});

test("no site URL: completed with no inventory; the inventory is never called", async () => {
  const { i } = siteInput();
  i.authority.site = { url: null };
  const { store, calls } = fakeStore({ input: async () => structuredClone(i) });
  let invCalls = 0;
  const { call, settle } = harness({ store, inventory: async () => { invCalls++; return invFrom([]); } });
  await call({ mode: "full", client_id: CLIENT });
  await settle();
  assert.equal(invCalls, 0);
  assert.equal(calls.record[0].p.status, "completed");
  assert.equal(calls.record[0].p.inventory, null);
});

test("refresh: reuses the latest completed inventory, fetches nothing, and hashes the same as the full run", async () => {
  const pages = siteInput().inv.pages;
  const stored = invFrom(pages);
  const full = fakeStore();
  const h1 = harness({ store: full.store, inventory: async () => stored });
  await h1.call({ mode: "full", client_id: CLIENT });
  await h1.settle();
  const { store, calls } = fakeStore({ latestInventory: async () => ({ run_id: RUN, inventory: { ...stored, fetched_at: "2026-09-25T20:00:00Z" } }) });
  let invCalls = 0;
  const h2 = harness({ store, inventory: async () => { invCalls++; return stored; } });
  const r = await h2.call({ mode: "refresh", client_id: CLIENT });
  assert.equal(r.status, 202);
  await h2.settle();
  assert.equal(invCalls, 0);
  assert.equal(calls.begin[0][1], "refresh");
  assert.equal(calls.record[0].p.status, "completed");
  assert.equal(calls.record[0].p.input_hash, full.calls.record[0].p.input_hash, "same facts + same inventory = same hash");
  assert.deepEqual(calls.record[0].p.report.opportunities.map((o) => o.key), full.calls.record[0].p.report.opportunities.map((o) => o.key));
});

test("a background exception records the run failed, without secrets; a failing record is swallowed", async () => {
  const { store, calls } = fakeStore({ input: async () => { throw new Error("upstream said Bearer eyJhbGciOi.secret-part token=abc123"); } });
  const { call, settle } = harness({ store });
  assert.equal((await call({ mode: "full", client_id: CLIENT })).status, 202);
  await settle();
  assert.equal(calls.record.length, 1);
  assert.equal(calls.record[0].p.status, "failed");
  assert.doesNotMatch(calls.record[0].p.error, /eyJhbGciOi|abc123/);

  const inv = fakeStore();
  const h = harness({ store: inv.store, inventory: async () => { throw new Error("inventory blew up"); } });
  await h.call({ mode: "full", client_id: CLIENT });
  await h.settle();
  assert.deepEqual(inv.calls.record[0].p, { status: "failed", error: "inventory blew up" });

  const broken = fakeStore({ fingerprint: async () => { throw new Error("x"); }, record: async () => { throw new Error("db gone"); } });
  const hb = harness({ store: broken.store });
  await hb.call({ mode: "full", client_id: CLIENT });
  await assert.doesNotReject(hb.settle(), "the background job never throws");
});

test("a report for another client is refused before recording (failed run)", async () => {
  const { i } = siteInput();
  i.client = { ...i.client, id: "44444444-4444-4444-8444-444444444444" };
  const { store, calls } = fakeStore({ input: async () => structuredClone(i) });
  const { call, settle } = harness({ store });
  await call({ mode: "full", client_id: CLIENT });
  await settle();
  assert.equal(calls.record[0].p.status, "failed");
  assert.match(calls.record[0].p.error, /not for this run's client/);
});

test("places come from the client's state in the gazetteer", async () => {
  const { store } = fakeStore();
  let seen = null;
  const orig = store.record;
  store.record = async (id, p) => { seen = p; return orig(id, p); };
  const { call, settle } = harness({ store, gazetteer: { MO: ["Saint Louis"] } });
  await call({ mode: "full", client_id: CLIENT });
  await settle();
  assert.equal(seen.status, "completed");
});

// ── classify.ts ─────────────────────────────────────────────────────────────
const home = (over) => page("/", over);
test("degraded rule: home page not 2xx", () => {
  assert.equal(classifyRun(SITE, invFrom([home()])).status, "completed");
  for (const s of [404, 500, 503, null]) assert.equal(classifyRun(SITE, invFrom([home({ status: s, final_status: s })])).status, "degraded", String(s));
  assert.equal(classifyRun(SITE, invFrom([home({ status: 301, final_status: 200, final_url: `${SITE}/home` })])).status, "completed", "a redirect to a 2xx home is fine");
  assert.equal(classifyRun(SITE, invFrom([page("/a")])).status, "degraded", "home page missing from the inventory");
});

test("degraded rule: 25% or more of requested URLs erroring; a 404 is a finding, not an error", () => {
  assert.equal(DEGRADED_ERROR_SHARE, 0.25);
  const ok = (n) => Array.from({ length: n }, (_, k) => page(`/ok${k}`));
  const err = (n, s) => Array.from({ length: n }, (_, k) => page(`/e${k}`, { status: s, final_status: s, final_url: s === null ? null : undefined }));
  assert.equal(classifyRun(SITE, invFrom([home(), ...ok(2), ...err(1, 502)])).status, "degraded", "1 of 4 = 25%");
  assert.equal(classifyRun(SITE, invFrom([home(), ...ok(3), ...err(1, 502)])).status, "completed", "1 of 5 = 20%");
  assert.equal(classifyRun(SITE, invFrom([home(), ...ok(2), ...err(1, null)])).inventory_errors, 1);
  const r404 = classifyRun(SITE, invFrom([home(), ...err(9, 404)]));
  assert.equal(r404.status, "completed");
  assert.equal(r404.inventory_errors, 0);
  const loop = page("/loop", { status: 308, final_url: null, final_status: null, redirect_loop: true });
  const off = page("/off", { status: 301, final_url: "https://elsewhere.example/", final_status: null });
  const refusedHop = page("/hop", { status: 301, final_url: `${SITE}/private`, final_status: null });
  assert.equal(isErrorPage(loop, SITE), false);
  assert.equal(isErrorPage(off, SITE), false);
  assert.equal(isErrorPage(refusedHop, SITE), true);
});

test("degraded rule: the inventory budget ran out; no site URL is completed", () => {
  assert.equal(classifyRun(SITE, invFrom([home()], { budget_exceeded: true })).status, "degraded");
  assert.deepEqual(classifyRun(null, null), { status: "completed", inventory_errors: 0, reasons: ["no site URL"] });
});

test("input hash: ignores now, asOf and the inventory's fetched_at; nothing else", async () => {
  const a = lucasAuthority();
  const b = structuredClone(a);
  b.authority.now = "2030-01-01T00:00:00Z"; b.asOf = "2030-01-01"; b.authority.inventory.fetched_at = "2030-01-01T00:00:00Z";
  assert.equal(await inputHash(a), await inputHash(b));
  const c = structuredClone(a);
  c.authority.inventory.pages[0].title = "Changed";
  assert.notEqual(await inputHash(a), await inputHash(c));
  const d = structuredClone(a);
  d.services = [...d.services].reverse();
  assert.notEqual(await inputHash(a), await inputHash(d), "array order is meaningful");
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
});

test("payload validation mirrors authority_record_run", () => {
  const base = () => ({ status: "completed", engine_version: "authority-v1.1", judged_at: "2026-09-25T20:00:00Z", as_of: "2026-09-25",
    input_hash: `sha256:${"a".repeat(64)}`, section_hashes: {}, inventory: null, inventory_errors: 0,
    report: { client: { id: CLIENT }, opportunities: [{ key: "create:service_page:x" }, { key: "fix:owner:y" }] } });
  assert.equal(validatePayload(base(), CLIENT), null);
  assert.match(validatePayload(base(), "55555555-5555-4555-8555-555555555555"), /client/);
  const dup = base(); dup.report.opportunities.push({ key: "fix:owner:y" });
  assert.match(validatePayload(dup, CLIENT), /unique/);
  const missing = base(); missing.report.opportunities.push({ key: null });
  assert.match(validatePayload(missing, CLIENT), /no key/);
  const bad = base(); bad.report.opportunities.push({ key: "Bad Key" });
  assert.match(validatePayload(bad, CLIENT), /malformed/);
  assert.match(validatePayload({ ...base(), input_hash: "md5:x" }, CLIENT), /input_hash/);
  assert.match(validatePayload({ ...base(), engine_version: "v1" }, CLIENT), /engine_version/);
  assert.equal(safeError(new Error("x".repeat(900))).length, 500);
});
