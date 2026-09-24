// Worker Google operations switch (app_settings 'worker_google_ops'): a
// valid Google token in Vault gives the unattended worker no authority to
// write to Google while the switch is off. Drives the real google-ops and
// gsc-sync request handlers with a fake Supabase (a valid refresh token in
// Vault) and a fake Google that records every call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoogleOps } from "../supabase/functions/google-ops/handler.ts";
import { createGscSync } from "../supabase/functions/gsc-sync/handler.ts";
import {
  isGoogleWrite,
  parseWorkerGoogleSetting,
  READ_ONLY_GOOGLE_OPS,
  workerGoogleOpsEnabled,
} from "../supabase/functions/_shared/worker-google.ts";

globalThis.EdgeRuntime = { waitUntil() {} };

const CLIENT = "00000000-0000-4000-b000-0000000000aa";
const CRON = { "x-cron-secret": "cron-secret", Authorization: "Bearer anon", "content-type": "application/json" };
const TEAM = { Authorization: "Bearer team-jwt", "content-type": "application/json" };

// A fake Supabase: Vault holds a VALID Google token; app_settings holds
// whatever the test sets; every write is recorded.
function fakeSupabase({ setting } = {}) {
  const writes = [];
  const secrets = {
    SYNC_CRON_SECRET: "cron-secret",
    GSC_CLIENT_ID: "cid", GSC_CLIENT_SECRET: "csec", GSC_REFRESH_TOKEN: "gsc-rt",
    GOOGLE_OPS_REFRESH_TOKEN: "ops-rt", GA4_ACCOUNT_ID: "123",
  };
  const rows = {
    app_settings: setting === undefined ? [] : [{ key: "worker_google_ops", value: setting }],
    clients: [{ id: CLIENT, name: "Lucas Construction", dba: null, phone: "417-555-0100", website_url: "https://lucas.example.test", city: "Springfield", state: "MO", gbp_location: "accounts/1/locations/2", gbp_spec: { description: "x", website: "https://lucas.example.test" }, ga4_property: null, gsc_property: "sc-domain:lucas.example.test" }],
    team_members: [{ id: "tm-1", auth_user_id: "user-1" }],
  };
  const builder = (table) => {
    const filters = [];
    let op = "select";
    const b = {
      select() { return b; },
      eq(col, val) { filters.push([col, val]); return b; },
      neq() { return b; }, in() { return b; }, order() { return b; }, limit() { return b; },
      update(v) { op = "update"; writes.push({ table, update: v }); return b; },
      insert(v) { op = "insert"; writes.push({ table, insert: v }); return b; },
      upsert(v) { op = "upsert"; writes.push({ table, upsert: v }); return b; },
      result() {
        if (op !== "select") return { data: null, error: null };
        const data = (rows[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
        return { data, error: null };
      },
      maybeSingle() { const r = b.result(); return Promise.resolve({ data: r.data?.[0] ?? null, error: null }); },
      single() { const r = b.result(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.data?.[0] ? null : { message: "not found" } }); },
      then(res, rej) { return Promise.resolve(b.result()).then(res, rej); },
    };
    return b;
  };
  return {
    writes,
    rpc: async (name, args) => (name === "get_secret" ? { data: secrets[args.secret_name] ?? null } : { data: null }),
    auth: { getUser: async (jwt) => ({ data: { user: jwt === "team-jwt" ? { id: "user-1" } : null } }) },
    from: builder,
  };
}

// A fake Google that answers everything successfully and records each call.
function fakeGoogle() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${String(url).replace(/\?.*/, "")}`);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const u = String(url);
    if (u.includes("oauth2.googleapis.com/token")) return json({ access_token: "valid-access-token" });
    if (u.includes("/webmasters/v3/sites") && !u.includes("/sitemaps/")) return json({ siteEntry: [{ siteUrl: "sc-domain:lucas.example.test", permissionLevel: "siteOwner" }] });
    if (u.includes("/accounts?")) return json({ accounts: [{ name: "accounts/1" }] });
    if (u.includes("/locations?")) return json({ locations: [{ name: "locations/2", title: "Lucas Construction", phoneNumbers: { primaryPhone: "417-555-0100" } }] });
    return json({ name: "created", id: "d1", message: { id: "m1" } });
  };
  return { calls, fetch };
}

const post = (handler, headers, body) =>
  handler(new Request("https://fn.local/x", { method: "POST", headers, body: JSON.stringify(body) }));

const WRITES = [
  ["gbp_apply", {}],
  ["gbp_qa", { qa: [{ q: "Do you do decks?", a: "Yes." }] }],
  ["ga4_provision", { site_url: "https://lucas.example.test" }],
  ["gmail_draft", { to: "owner@lucas.example.test", subject: "Report", text: "Hello" }],
  ["gbp_reviews_reply", {}], // a future op nobody has classified yet
];

test("only an explicit enabled: true turns worker Google writes on", async () => {
  for (const v of [undefined, null, {}, { enabled: "true" }, { enabled: 1 }, [], "true", { enabled: false }]) {
    assert.equal(parseWorkerGoogleSetting(v).enabled, false, JSON.stringify(v));
  }
  assert.equal(parseWorkerGoogleSetting({ enabled: true }).enabled, true);
  assert.equal(await workerGoogleOpsEnabled(fakeSupabase()), false, "no row = off");
  assert.equal(await workerGoogleOpsEnabled({ from: () => { throw new Error("db down"); } }), false, "unreadable = off");
});

test("every op is a Google write unless it is on the read-only list", () => {
  assert.deepEqual([...READ_ONLY_GOOGLE_OPS], ["gbp_locate"]);
  for (const [op] of WRITES) assert.equal(isGoogleWrite(op), true, op);
  assert.equal(isGoogleWrite("gbp_locate"), false);
});

test("switch off: a valid token gives the worker no google-ops write — nothing reaches Google or the CRM", async () => {
  for (const setting of [undefined, { enabled: false }]) {
    for (const [op, extra] of WRITES) {
      const sb = fakeSupabase({ setting });
      const g = fakeGoogle();
      const res = await post(createGoogleOps({ supabase: sb, fetch: g.fetch }), CRON, { client_id: CLIENT, op, ...extra });
      const body = await res.json();
      assert.equal(res.status, 403, `${op} (${JSON.stringify(setting)})`);
      assert.equal(body.status, "skipped", "the worker already turns 'skipped' into Tom's task");
      assert.equal(body.reason, "worker_google_ops_off");
      assert.deepEqual(g.calls, [], `${op}: no Google call at all, not even the token refresh`);
      assert.deepEqual(sb.writes, [], `${op}: no CRM write`);
    }
  }
});

test("switch off: read-only access checks still run for the worker", async () => {
  const sb = fakeSupabase();
  const g = fakeGoogle();
  const res = await post(createGoogleOps({ supabase: sb, fetch: g.fetch }), CRON, { client_id: CLIENT, op: "gbp_locate" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "done");
  assert.ok(g.calls.every((c) => c.startsWith("GET ") || c.includes("oauth2.googleapis.com/token")), "reads only");
});

test("switch on: the same worker calls go through to Google", async () => {
  for (const [op, extra] of WRITES.slice(0, 4)) {
    const sb = fakeSupabase({ setting: { enabled: true, changed_by: "Tom", changed_at: "2026-09-24T12:00:00Z" } });
    const g = fakeGoogle();
    const res = await post(createGoogleOps({ supabase: sb, fetch: g.fetch }), CRON, { client_id: CLIENT, op, ...extra });
    assert.notEqual((await res.json()).reason, "worker_google_ops_off", op);
    assert.ok(g.calls.some((c) => c.includes("oauth2.googleapis.com/token")), `${op}: reached Google`);
  }
});

test("the switch binds the worker, not a team member acting in person; gbp_posts stays retired for everyone", async () => {
  const sb = fakeSupabase();
  const g = fakeGoogle();
  const res = await post(createGoogleOps({ supabase: sb, fetch: g.fetch }), TEAM, { client_id: CLIENT, op: "gmail_draft", to: "a@b.test", subject: "s", text: "t" });
  assert.equal(res.status, 200);
  assert.ok(g.calls.length > 0);
  for (const headers of [CRON, TEAM]) {
    const h = fakeGoogle();
    const r = await post(createGoogleOps({ supabase: fakeSupabase({ setting: { enabled: true } }), fetch: h.fetch }), headers, { client_id: CLIENT, op: "gbp_posts" });
    assert.equal(r.status, 410);
    assert.deepEqual(h.calls, []);
  }
  // No credentials at all is still refused before anything else.
  const anon = await post(createGoogleOps({ supabase: fakeSupabase(), fetch: fakeGoogle().fetch }), { "content-type": "application/json" }, { client_id: CLIENT, op: "gbp_apply" });
  assert.equal(anon.status, 401);
});

test("gsc-sync: the worker cannot submit a sitemap while the switch is off; the read-only sync is untouched", async () => {
  const sitemap = { client_id: CLIENT, submit_sitemap: "https://lucas.example.test/sitemap.xml" };
  const off = fakeGoogle();
  const refused = await post(createGscSync({ supabase: fakeSupabase(), fetch: off.fetch }), CRON, sitemap);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).reason, "worker_google_ops_off");
  assert.deepEqual(off.calls, [], "no token refresh, no PUT");

  const on = fakeGoogle();
  const allowed = await post(createGscSync({ supabase: fakeSupabase({ setting: { enabled: true } }), fetch: on.fetch }), CRON, sitemap);
  assert.equal(allowed.status, 200);
  assert.ok(on.calls.some((c) => c.startsWith("PUT ") && c.includes("/sitemaps/")));

  const person = fakeGoogle();
  const byPerson = await post(createGscSync({ supabase: fakeSupabase(), fetch: person.fetch }), TEAM, sitemap);
  assert.equal(byPerson.status, 200, "a team member in person is not the worker");

  const sync = fakeGoogle();
  const read = await post(createGscSync({ supabase: fakeSupabase(), fetch: sync.fetch }), CRON, {});
  assert.equal(read.status, 202, "the monthly read-only sync runs with the switch off");
  assert.ok(!sync.calls.some((c) => c.startsWith("PUT ") || c.includes("/sitemaps/")), "no Search Console write");
});
