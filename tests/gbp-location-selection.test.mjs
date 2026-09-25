// A Business Profile location reaches clients.gbp_location only through a
// person's confirmed pick (google-connect gbp_select). google-ops matches by
// phone / website / exact name to SUGGEST, never to store; with no location
// selected its Business Profile ops stop with GBP_LOCATION_REQUIRED. The
// publisher side is covered in tests/post-publisher-handler.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoogleOps } from "../supabase/functions/google-ops/handler.ts";
import { createGoogleConnect } from "../supabase/functions/google-connect/handler.ts";

const CLIENT = "00000000-0000-4000-b000-0000000000aa";
const CRON = { "x-cron-secret": "cron-secret", Authorization: "Bearer anon", "content-type": "application/json" };
const TEAM = { Authorization: "Bearer team-jwt", "content-type": "application/json" };
const RES = "accounts/1/locations/12";

// One in-memory database both functions can share; every write recorded.
function fakeSupabase({ gbpLocation = null, workerOps = { enabled: true } } = {}) {
  const writes = [];
  const db = {
    clients: [{ id: CLIENT, name: "Lucas Construction", dba: null, phone: "(636) 459-9328", website_url: "https://lucasconstructionmo.com", city: "Wentzville", state: "MO", gbp_location: gbpLocation, gbp_spec: { description: "Roofing in Wentzville.", website: "https://lucasconstructionmo.com" }, ga4_property: null }],
    team_members: [{ id: "tm-1", auth_user_id: "user-1" }],
    app_settings: workerOps ? [{ key: "worker_google_ops", value: workerOps }] : [],
  };
  const secrets = { SYNC_CRON_SECRET: "cron-secret", GSC_CLIENT_ID: "cid", GSC_CLIENT_SECRET: "csec", GSC_REFRESH_TOKEN: "gsc-rt", GOOGLE_OPS_REFRESH_TOKEN: "ops-rt" };
  const from = (table) => {
    const filters = [];
    let op = "select";
    let patch = null;
    let returning = false;
    const b = {
      select() { if (op !== "select") returning = true; return b; },
      eq(c, v) { filters.push([c, v]); return b; },
      is(c, v) { filters.push([c, v]); return b; },
      neq() { return b; }, in() { return b; }, not() { return b; }, order() { return b; }, limit() { return b; },
      update(v) { op = "update"; patch = v; return b; },
      upsert(v) { op = "upsert"; patch = v; return b; },
      insert(v) { op = "insert"; patch = v; return b; },
      run() {
        const rows = (db[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
        if (op === "select") return { data: rows.map((r) => ({ ...r })), error: null };
        writes.push({ table, [op]: patch });
        if (op === "update") for (const r of rows) Object.assign(r, patch);
        return { data: returning ? rows.map((r) => ({ id: r.id })) : null, error: null };
      },
      maybeSingle() { const r = b.run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: null }); },
      single() { const r = b.run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.data?.[0] ? null : { message: "not found" } }); },
      then(res, rej) { return Promise.resolve(b.run()).then(res, rej); },
    };
    return b;
  };
  return {
    db, writes,
    rpc: async (name, args) => (name === "get_secret" ? { data: secrets[args.secret_name] ?? null } : { data: null }),
    auth: { getUser: async (jwt) => ({ data: { user: jwt === "team-jwt" ? { id: "user-1" } : null } }) },
    from,
  };
}

// Two accounts pages; accounts/1 has two location pages. Candidates: an exact
// phone + name + website match, a website-only match, a partial title, and an
// unrelated business.
function fakeGoogle() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const u = String(url);
    calls.push(`${method} ${u.replace(/\?.*/, "")}`);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "at" });
    if (u.includes("mybusinessaccountmanagement.googleapis.com/v1/accounts")) {
      return u.includes("pageToken=a2") ? json({ accounts: [{ name: "accounts/2" }] }) : json({ accounts: [{ name: "accounts/1" }], nextPageToken: "a2" });
    }
    if (u.includes("/v1/accounts/1/locations")) {
      return u.includes("pageToken=l2")
        ? json({ locations: [{ name: "locations/12", title: "Lucas Construction", phoneNumbers: { primaryPhone: "+1 636-459-9328" }, websiteUri: "https://www.lucasconstructionmo.com/" }] })
        : json({ locations: [{ name: "locations/11", title: "Some Bakery", phoneNumbers: { primaryPhone: "(314) 555-0101" } }], nextPageToken: "l2" });
    }
    if (u.includes("/v1/accounts/2/locations")) {
      return json({ locations: [
        { name: "locations/21", title: "Lucas Construction Supply Co", phoneNumbers: { primaryPhone: "(636) 555-0199" } },
        { name: "locations/22", title: "Lucas Roofing Old Listing", websiteUri: "https://lucasconstructionmo.com" },
      ] });
    }
    if (/\/v1\/locations\/12\?/.test(u) && method === "GET") return json({ name: "locations/12", title: "Lucas Construction", metadata: { mapsUri: "https://maps.example/12" } });
    if (u.includes("/localPosts")) return json({ localPosts: [] });
    if (u.includes("/v1/categories")) return json({ categories: [] });
    if (method === "PATCH") return json({ name: "locations/12" });
    return json({ error: { message: `unexpected ${u}` } }, 404);
  };
  return { calls, fetch };
}

const call = async (handler, headers, body) => {
  const res = await handler(new Request("https://fn.local/x", { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const googleWrites = (calls) => calls.filter((c) => !c.startsWith("GET ") && !c.includes("oauth2.googleapis.com/token"));
const clientWrites = (writes) => writes.filter((w) => w.table === "clients");

test("gbp_locate never stores a location: exact phone / name / website matches come back as ranked suggestions", async () => {
  for (const headers of [CRON, TEAM]) {
    const sb = fakeSupabase();
    const g = fakeGoogle();
    const { status, body } = await call(createGoogleOps({ supabase: sb, fetch: g.fetch }), headers, { client_id: CLIENT, op: "gbp_locate" });
    assert.equal(status, 200);
    assert.equal(body.status, "skipped");
    assert.equal(body.reason, "GBP_LOCATION_REQUIRED");
    assert.deepEqual(body.suggestions.map((c) => c.resource), [RES, "accounts/2/locations/22"], "strongest first; partial title and unrelated excluded");
    assert.deepEqual(body.suggestions[0].hints, { phone: true, website: true, exact_name: true });
    assert.deepEqual(body.suggestions[1].hints, { phone: false, website: true, exact_name: false });
    assert.equal(sb.db.clients[0].gbp_location, null, "a perfect match is still only a suggestion");
    assert.deepEqual(sb.writes, [], "no CRM write at all");
    assert.deepEqual(googleWrites(g.calls), [], "GET only");
    assert.ok(g.calls.some((c) => c.includes("/v1/accounts/2/locations")), "both account pages read");
  }
});

test("gbp_locate with a selected location reports it and changes nothing", async () => {
  const sb = fakeSupabase({ gbpLocation: RES });
  const g = fakeGoogle();
  const { status, body } = await call(createGoogleOps({ supabase: sb, fetch: g.fetch }), CRON, { client_id: CLIENT, op: "gbp_locate" });
  assert.equal(status, 200);
  assert.equal(body.status, "done");
  assert.equal(body.location, RES);
  assert.deepEqual(sb.writes, []);
  assert.ok(!g.calls.some((c) => c.includes("/v1/accounts")), "no search for another one");
});

test("gbp_apply and gbp_qa stop with GBP_LOCATION_REQUIRED when none is selected: no Google write, no CRM write", async () => {
  for (const [op, extra] of [["gbp_apply", {}], ["gbp_qa", { qa: [{ q: "Do you repair storm damage?", a: "Yes." }] }]]) {
    const sb = fakeSupabase();
    const g = fakeGoogle();
    const { status, body } = await call(createGoogleOps({ supabase: sb, fetch: g.fetch }), CRON, { client_id: CLIENT, op, ...extra });
    assert.equal(status, 200, op);
    assert.equal(body.status, "skipped", op);
    assert.equal(body.reason, "GBP_LOCATION_REQUIRED", op);
    assert.deepEqual(googleWrites(g.calls), [], op);
    assert.ok(!g.calls.some((c) => c.includes("/v1/accounts")), `${op}: no discovery`);
    assert.deepEqual(clientWrites(sb.writes), [], op);
  }
});

test("an existing selected location keeps working for gbp_apply", async () => {
  const sb = fakeSupabase({ gbpLocation: RES });
  const g = fakeGoogle();
  const { body } = await call(createGoogleOps({ supabase: sb, fetch: g.fetch }), CRON, { client_id: CLIENT, op: "gbp_apply" });
  assert.equal(body.status, "done", JSON.stringify(body));
  assert.deepEqual(googleWrites(g.calls), ["PATCH https://mybusinessbusinessinformation.googleapis.com/v1/locations/12"]);
  assert.equal(sb.db.clients[0].gbp_location, RES, "never replaced");
  assert.deepEqual(clientWrites(sb.writes), []);
});

test("only gbp_select creates the canonical value", async () => {
  const sb = fakeSupabase();
  const g = fakeGoogle();
  const ops = createGoogleOps({ supabase: sb, fetch: g.fetch });
  const connect = createGoogleConnect({ supabase: sb, fetch: g.fetch, selfUrl: "https://fn.local/google-connect" });

  await call(ops, CRON, { client_id: CLIENT, op: "gbp_locate" });
  await call(ops, TEAM, { client_id: CLIENT, op: "gbp_locate" });
  await call(connect, TEAM, { mode: "gbp_locations", client_id: CLIENT });
  await call(connect, TEAM, { mode: "access" });
  assert.equal(sb.db.clients[0].gbp_location, null, "discovery, suggestions and the access report never store it");
  assert.deepEqual(clientWrites(sb.writes), []);

  const picked = await call(connect, TEAM, { mode: "gbp_select", client_id: CLIENT, location: RES, title: "Lucas Construction", confirm: true });
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
  assert.equal(sb.db.clients[0].gbp_location, RES);
  assert.deepEqual(clientWrites(sb.writes).map((w) => w.update), [{ gbp_location: RES }]);
  assert.deepEqual(googleWrites(g.calls), []);
  assert.deepEqual(sb.writes.filter((w) => w.table === "app_settings" && ["worker_google_ops", "publisher"].includes(w.upsert?.key)), []);
});
