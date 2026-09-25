// google-connect (Business Profile connection, discovery and explicit
// location selection): the real request handler over a fake Supabase (an
// in-memory clients table, Vault and app_settings that record every write)
// and a fake Google that records every call. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createGoogleConnect, GBP_CONNECT_SCOPES, BUSINESS_MANAGE, safeReturnTo } from "../supabase/functions/google-connect/handler.ts";
import { createGscSync } from "../supabase/functions/gsc-sync/handler.ts";

globalThis.EdgeRuntime = { waitUntil() {} };

const SELF = "https://proj.supabase.test/functions/v1/google-connect";
const LUCAS = "00000000-0000-4000-b000-0000000000aa";
const OTHER = "00000000-0000-4000-b000-0000000000bb";
const TEAM = { Authorization: "Bearer team-jwt", "content-type": "application/json" };
const LUCAS_RES = "accounts/1/locations/12";

function fakeSupabase({ lucasLocation = null, opsToken = "ops-rt" } = {}) {
  const writes = [];
  const log = [];
  const secrets = { SYNC_CRON_SECRET: "cron-secret", GSC_CLIENT_ID: "cid", GSC_CLIENT_SECRET: "csec", GSC_REFRESH_TOKEN: "gsc-rt" };
  if (opsToken) secrets.GOOGLE_OPS_REFRESH_TOKEN = opsToken;
  const db = {
    clients: [
      { id: LUCAS, name: "Lucas Construction", dba: null, phone: "(636) 459-9328", website_url: "https://lucasconstructionmo.com", gbp_location: lucasLocation, gsc_property: "https://lucasconstructionmo.com/", ga4_property: null, status: "launching" },
      { id: OTHER, name: "Other Client", dba: null, phone: "417-555-0100", website_url: "https://other.example.test", gbp_location: null, gsc_property: null, ga4_property: null, status: "active" },
    ],
    team_members: [{ id: "tm-1", auth_user_id: "user-1" }],
    app_settings: [],
  };
  const from = (table) => {
    const filters = [];
    let op = "select";
    let patch = null;
    let returning = false;
    const matches = (r) => filters.every(([kind, c, v]) => (kind === "eq" ? r[c] === v : kind === "is" ? r[c] === v : true));
    const b = {
      select() { if (op !== "select") returning = true; return b; },
      eq(c, v) { filters.push(["eq", c, v]); return b; },
      is(c, v) { filters.push(["is", c, v]); return b; },
      not() { return b; }, neq() { return b; }, gte() { return b; }, order() { return b; }, in() { return b; }, limit() { return b; },
      update(v) { op = "update"; patch = v; return b; },
      upsert(v) { op = "upsert"; patch = v; return b; },
      insert(v) { op = "insert"; patch = v; return b; },
      run() {
        const rows = db[table] ?? [];
        if (op === "select") return { data: rows.filter(matches).map((r) => ({ ...r })), error: null };
        if (op === "update") {
          const hit = rows.filter(matches);
          for (const r of hit) Object.assign(r, patch);
          writes.push({ table, update: patch, filters: [...filters], rows: hit.length });
          log.push(`db update ${table}`);
          return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
        }
        writes.push({ table, [op]: patch });
        log.push(`db ${op} ${table}`);
        if (op === "upsert" && table === "app_settings") {
          const i = rows.findIndex((r) => r.key === patch.key);
          if (i >= 0) rows[i] = patch; else rows.push(patch);
        }
        return { data: null, error: null };
      },
      maybeSingle() { const r = b.run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: null }); },
      single() { const r = b.run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.data?.[0] ? null : { message: "not found" } }); },
      then(res, rej) { return Promise.resolve(b.run()).then(res, rej); },
    };
    return b;
  };
  return {
    db, writes, log, secrets,
    rpc: async (name, args) => {
      if (name === "get_secret") return { data: secrets[args.secret_name] ?? null };
      if (name === "set_secret") { writes.push({ secret: args.secret_name }); log.push(`secret ${args.secret_name}`); secrets[args.secret_name] = args.secret_value; return { error: null }; }
      return { data: null };
    },
    auth: { getUser: async (jwt) => ({ data: { user: jwt === "team-jwt" ? { id: "user-1" } : jwt === "client-jwt" ? { id: "user-9" } : null } }) },
    from,
  };
}

const LOC = {
  11: { name: "locations/11", title: "Some Bakery", phoneNumbers: { primaryPhone: "(314) 555-0101" }, websiteUri: "https://bakery.example.test", storefrontAddress: { addressLines: ["1 Main St"], locality: "St. Louis", administrativeArea: "MO", postalCode: "63101" }, metadata: { mapsUri: "https://maps.google.com/?cid=11", hasVoiceOfMerchant: true } },
  12: { name: "locations/12", title: "Lucas Construction", phoneNumbers: { primaryPhone: "(636) 459-9328" }, websiteUri: "https://lucasconstructionmo.com/", serviceArea: { businessType: "CUSTOMER_LOCATION_ONLY", places: { placeInfos: [{ placeName: "Wentzville, MO, USA" }] } }, metadata: { mapsUri: "https://maps.google.com/?cid=12", placeId: "place-12", hasVoiceOfMerchant: true } },
  21: { name: "locations/21", title: "Lucas Construction Supply Co", phoneNumbers: { primaryPhone: "(636) 555-0199" }, metadata: { mapsUri: "https://maps.google.com/?cid=21" } },
};

// Two pages of accounts, two pages of locations under accounts/1.
function fakeGoogle({ grantedScope = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/business.manage", overrides = {}, log = null } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const u = String(url);
    calls.push({ method, url: u, body: init.body ? String(init.body) : null });
    log?.push(`google ${method} ${u.replace(/\?.*/, "")}`);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    for (const [frag, answer] of Object.entries(overrides)) if (u.includes(frag)) return json(answer.body, answer.status);
    if (u.startsWith("https://oauth2.googleapis.com/token")) {
      const p = new URLSearchParams(String(init.body));
      return p.get("grant_type") === "authorization_code"
        ? json({ access_token: "at-new", refresh_token: "rt-new", scope: grantedScope })
        : json({ access_token: `at-for-${p.get("refresh_token")}` });
    }
    if (u.includes("openidconnect.googleapis.com/v1/userinfo")) return json({ email: "thomas@compassmarketing.ai" });
    if (u.includes("mybusinessaccountmanagement.googleapis.com/v1/accounts")) {
      return u.includes("pageToken=acct-p2")
        ? json({ accounts: [{ name: "accounts/2", accountName: "Other org", type: "ORGANIZATION" }] })
        : json({ accounts: [{ name: "accounts/1", accountName: "Compass", type: "PERSONAL" }], nextPageToken: "acct-p2" });
    }
    if (u.includes("/v1/accounts/1/locations")) {
      return u.includes("pageToken=loc-p2") ? json({ locations: [LOC[12]] }) : json({ locations: [LOC[11]], nextPageToken: "loc-p2" });
    }
    if (u.includes("/v1/accounts/2/locations")) return json({ locations: [LOC[21]] });
    const one = /\/v1\/locations\/(\d+)\?/.exec(u);
    if (one) return LOC[one[1]] ? json(LOC[one[1]]) : json({ error: { message: "not found" } }, 404);
    if (u.includes("mybusiness.googleapis.com/v4/") && u.includes("/localPosts")) return json({ localPosts: [] });
    if (u.includes("/webmasters/v3/sites")) return json({ siteEntry: [{ siteUrl: "https://lucasconstructionmo.com/", permissionLevel: "siteOwner" }] });
    return json({ error: { message: `unexpected ${u}` } }, 404);
  };
  return { calls, fetch };
}

// A Google write: anything but a GET, except the OAuth token endpoint.
const googleWrites = (calls) => calls.filter((c) => c.method !== "GET" && !c.url.startsWith("https://oauth2.googleapis.com/token"));
const switchWrites = (writes) => writes.filter((w) => w.table === "app_settings" && ["worker_google_ops", "publisher"].includes(w.upsert?.key ?? w.update?.key));

function setup(opts = {}) {
  const sb = fakeSupabase(opts);
  const g = fakeGoogle({ ...opts, log: sb.log });
  const handler = createGoogleConnect({ supabase: sb, fetch: g.fetch, selfUrl: SELF });
  const post = async (body, headers = TEAM) => {
    const res = await handler(new Request(SELF, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: res.status, body: await res.json() };
  };
  const get = (qs) => handler(new Request(`${SELF}?${qs}`, { method: "GET" }));
  return { sb, g, handler, post, get };
}

async function signedState(t) {
  const { body } = await t.post({ mode: "start", return_to: "https://compass-crm-ten.vercel.app/settings" });
  return new URL(body.url).searchParams.get("state");
}

// ── Connect ───────────────────────────────────────────────────────────────────
test("Connect requests openid, email and business.manage only, with include_granted_scopes=false", async () => {
  const t = setup();
  const { status, body } = await t.post({ mode: "start", return_to: "https://compass-crm-ten.vercel.app/settings" });
  assert.equal(status, 200);
  const q = new URL(body.url).searchParams;
  assert.deepEqual(q.get("scope").split(" "), ["openid", "email", "https://www.googleapis.com/auth/business.manage"]);
  assert.deepEqual([...GBP_CONNECT_SCOPES], ["openid", "email", BUSINESS_MANAGE]);
  assert.equal(q.get("include_granted_scopes"), "false");
  assert.equal(q.get("access_type"), "offline", "a refresh token is still requested");
  assert.equal(q.get("prompt"), "consent");
  assert.equal(q.get("redirect_uri"), SELF);
  for (const unwanted of ["analytics", "gmail", "webmasters", "drive"]) assert.ok(!q.get("scope").includes(unwanted), unwanted);
  assert.deepEqual(t.g.calls, [], "starting makes no Google call");
  assert.deepEqual(t.sb.writes, []);
});

test("the callback stores only GOOGLE_OPS_REFRESH_TOKEN, records the granted scopes, and writes nothing to Google", async () => {
  const t = setup({ opsToken: null });
  const state = await signedState(t);
  const res = await t.get(`code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get("location")).searchParams.get("google"), "connected");
  assert.deepEqual(t.sb.writes.filter((w) => w.secret).map((w) => w.secret), ["GOOGLE_OPS_REFRESH_TOKEN"], "never GSC_REFRESH_TOKEN");
  assert.equal(t.sb.secrets.GSC_REFRESH_TOKEN, "gsc-rt", "the Search Console token is untouched");
  const ops = t.sb.db.app_settings.find((r) => r.key === "google_ops").value;
  assert.deepEqual(ops.scopes, ["openid", "https://www.googleapis.com/auth/userinfo.email", BUSINESS_MANAGE]);
  assert.deepEqual(ops.missing_scopes, []);
  assert.equal(ops.email, "thomas@compassmarketing.ai");
  assert.deepEqual(googleWrites(t.g.calls), []);
  assert.deepEqual(switchWrites(t.sb.writes), []);
  assert.deepEqual(t.sb.writes.filter((w) => w.table === "clients"), []);
});

test("a token broader than Business Profile is refused and not stored", async () => {
  const t = setup({ opsToken: null, grantedScope: `openid email ${BUSINESS_MANAGE} https://www.googleapis.com/auth/webmasters` });
  const state = await signedState(t);
  const res = await t.get(`code=abc&state=${encodeURIComponent(state)}`);
  const back = new URL(res.headers.get("location")).searchParams;
  assert.equal(back.get("google"), "error");
  assert.match(back.get("reason"), /webmasters.*not stored/);
  assert.deepEqual(t.sb.writes, [], "no secret, no setting");
});

test("a token without business.manage is stored as partial (and says what is missing)", async () => {
  const t = setup({ opsToken: null, grantedScope: "openid email" });
  const state = await signedState(t);
  const res = await t.get(`code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(new URL(res.headers.get("location")).searchParams.get("google"), "partial");
});

test("a forged or expired state is refused before any token exchange", async () => {
  const t = setup();
  const res = await t.get("code=abc&state=bogus.sig");
  assert.equal(res.status, 400);
  assert.deepEqual(t.g.calls, []);
  assert.deepEqual(t.sb.writes, []);
});

test("every mode needs a team member", async () => {
  const t = setup();
  assert.equal((await t.post({ mode: "gbp_locations" }, { "content-type": "application/json" })).status, 401);
  assert.equal((await t.post({ mode: "gbp_select", client_id: LUCAS, location: LUCAS_RES, title: "Lucas Construction", confirm: true }, { Authorization: "Bearer client-jwt" })).status, 403);
  assert.deepEqual(t.g.calls, []);
  assert.deepEqual(t.sb.writes, []);
});

// ── Return URLs ───────────────────────────────────────────────────────────────
const GOOD = [
  "https://compass-crm-ten.vercel.app/settings",
  "https://compass-crm-ten.vercel.app/settings?tab=google#worker-google",
  "http://localhost:3000/settings",
];
const BAD = [
  "https://evil.example/settings",
  "https://compass-crm-ten.vercel.app.evil.example/settings",
  "https://compass-crm-ten.vercel.app@evil.example/settings",
  "https://user:pw@compass-crm-ten.vercel.app/settings",
  "http://compass-crm-ten.vercel.app/settings",
  "https://localhost:3000/settings",
  "http://localhost:3001/settings",
  "http://localhost/settings",
  "https://preview-abc.vercel.app/settings",
  "//evil.example/settings",
  "/settings",
  "https:/\\evil.example",
  "https:\\\\evil.example",
  "javascript:alert(1)",
  "data:text/html,hi",
  "ftp://compass-crm-ten.vercel.app/settings",
  "not a url",
  "",
  null,
  42,
  { href: "https://compass-crm-ten.vercel.app/settings" },
  "https://compass-crm-ten.vercel.app/" + "x".repeat(3000),
];

test("return URLs: only the Compass app origin (and local development) are accepted", () => {
  for (const u of GOOD) assert.equal(new URL(safeReturnTo(u)).origin, new URL(u).origin, u);
  for (const u of BAD) assert.equal(safeReturnTo(u), null, JSON.stringify(u));
});

test("start refuses a return URL outside the Compass app, before signing anything", async () => {
  for (const u of BAD) {
    const t = setup();
    const { status, body } = await t.post({ mode: "start", return_to: u });
    assert.equal(status, 400, JSON.stringify(u));
    assert.match(body.error, /Compass app/);
    assert.equal(body.url, undefined);
  }
  for (const u of GOOD) {
    const t = setup();
    const { status, body } = await t.post({ mode: "start", return_to: u });
    assert.equal(status, 200, u);
    assert.ok(body.url.startsWith("https://accounts.google.com/"));
  }
});

// A state signed with the real key but carrying a bad return_to (as one
// minted before this check would): the callback falls back to Settings.
function forgeSigned(payload, key = "cron-secret") {
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${b64}.${createHmac("sha256", key).update(b64).digest("base64url")}`;
}

test("the callback only ever redirects to the Compass app, and keeps the signature and expiry checks", async () => {
  const exp = Date.now() + 60_000;
  const t = setup({ opsToken: null });
  const res = await t.get(`error=access_denied&state=${encodeURIComponent(forgeSigned({ exp, return_to: "https://evil.example/steal", nonce: "n" }))}`);
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get("location"));
  assert.equal(to.origin, "https://compass-crm-ten.vercel.app");
  assert.equal(to.pathname, "/settings");

  const ok = setup({ opsToken: null });
  const good = await ok.get(`code=abc&state=${encodeURIComponent(forgeSigned({ exp, return_to: "http://localhost:3000/settings", nonce: "n" }))}`);
  assert.equal(new URL(good.headers.get("location")).origin, "http://localhost:3000");

  const expired = setup();
  assert.equal((await expired.get(`code=abc&state=${encodeURIComponent(forgeSigned({ exp: Date.now() - 1, return_to: "https://compass-crm-ten.vercel.app/settings", nonce: "n" }))}`)).status, 400);
  const wrongKey = setup();
  assert.equal((await wrongKey.get(`code=abc&state=${encodeURIComponent(forgeSigned({ exp, return_to: "https://compass-crm-ten.vercel.app/settings", nonce: "n" }, "other-key"))}`)).status, 400);
  assert.deepEqual(expired.g.calls, []);
  assert.deepEqual(wrongKey.g.calls, []);
  assert.deepEqual(wrongKey.sb.writes, []);
});

// ── Discovery ─────────────────────────────────────────────────────────────────
test("discovery pages through every account and every location, read-only", async () => {
  const t = setup();
  const { status, body } = await t.post({ mode: "gbp_locations", client_id: LUCAS });
  assert.equal(status, 200);
  assert.equal(body.accounts, 2, "both account pages");
  assert.deepEqual(body.candidates.map((c) => c.resource), ["accounts/1/locations/11", "accounts/1/locations/12", "accounts/2/locations/21"], "both location pages");
  assert.equal(body.complete, true);
  const lucas = body.candidates.find((c) => c.resource === LUCAS_RES);
  assert.equal(lucas.title, "Lucas Construction");
  assert.equal(lucas.phone, "(636) 459-9328");
  assert.equal(lucas.website, "https://lucasconstructionmo.com/");
  assert.equal(lucas.service_area, "Wentzville, MO, USA");
  assert.equal(lucas.maps_uri, "https://maps.google.com/?cid=12");
  assert.equal(lucas.account_name, "Compass");
  assert.deepEqual(lucas.hints, { phone: true, website: true, exact_name: true });
  const partial = body.candidates.find((c) => c.resource === "accounts/2/locations/21");
  assert.deepEqual(partial.hints, { phone: false, website: false, exact_name: false }, "a partial title is not a match");
  assert.equal(body.candidates.find((c) => c.resource === "accounts/1/locations/11").address, "1 Main St, St. Louis, MO, 63101");
  assert.ok(t.g.calls.some((c) => c.url.includes("pageToken=acct-p2")));
  assert.ok(t.g.calls.some((c) => c.url.includes("pageToken=loc-p2")));
  assert.deepEqual(googleWrites(t.g.calls), [], "GET only");
  assert.deepEqual(t.sb.writes, [], "no CRM write either: nothing is selected");
  assert.equal(t.sb.db.clients.find((c) => c.id === LUCAS).gbp_location, null);
});

test("a failed location page marks the listing incomplete instead of hiding it", async () => {
  const t = setup({ overrides: { "/v1/accounts/2/locations": { status: 403, body: { error: { message: "denied" } } } } });
  const { body } = await t.post({ mode: "gbp_locations" });
  assert.equal(body.complete, false);
  assert.match(body.errors.join(" "), /accounts\/2 locations: denied/);
});

// ── Selection ─────────────────────────────────────────────────────────────────
test("selection needs an explicit, well-formed, confirmed candidate", async () => {
  const t = setup();
  for (const body of [
    { mode: "gbp_select", client_id: LUCAS },
    { mode: "gbp_select", client_id: LUCAS, location: "Lucas Construction", title: "Lucas Construction", confirm: true },
    { mode: "gbp_select", client_id: LUCAS, location: "locations/12", title: "Lucas Construction", confirm: true },
    { mode: "gbp_select", client_id: LUCAS, location: LUCAS_RES, title: "Lucas Construction" },
    { mode: "gbp_select", client_id: LUCAS, location: LUCAS_RES, confirm: true },
    { mode: "gbp_select", location: LUCAS_RES, title: "Lucas Construction", confirm: true },
  ]) {
    assert.equal((await t.post(body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(t.g.calls, []);
  assert.deepEqual(t.sb.writes, []);
});

test("selection verifies the exact location with Google before storing it, only while empty", async () => {
  const t = setup();
  const { status, body } = await t.post({ mode: "gbp_select", client_id: LUCAS, location: LUCAS_RES, title: "Lucas Construction", confirm: true });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.location, LUCAS_RES);
  assert.equal(body.verified.title, "Lucas Construction");
  assert.equal(body.posts_readable, true);
  assert.equal(t.sb.db.clients.find((c) => c.id === LUCAS).gbp_location, LUCAS_RES);
  const update = t.sb.writes.find((w) => w.table === "clients");
  assert.deepEqual(update.update, { gbp_location: LUCAS_RES });
  assert.ok(update.filters.some(([k, c, v]) => k === "is" && c === "gbp_location" && v === null), "guarded on empty");
  const order = t.sb.log;
  const verifyAt = order.findIndex((l) => l.includes("GET https://mybusinessbusinessinformation.googleapis.com/v1/locations/12"));
  const listAt = order.findIndex((l) => l.includes("/v1/accounts/1/locations"));
  const saveAt = order.indexOf("db update clients");
  assert.ok(verifyAt >= 0 && listAt >= 0 && verifyAt < saveAt && listAt < saveAt, order.join("\n"));
  assert.equal(t.sb.db.clients.find((c) => c.id === OTHER).gbp_location, null, "no other client touched");
  assert.deepEqual(googleWrites(t.g.calls), []);
  assert.deepEqual(switchWrites(t.sb.writes), []);
  assert.deepEqual(t.sb.writes.filter((w) => w.secret), []);
});

test("nothing is stored when Google cannot open the location, its name changed, or it is not in that account", async () => {
  const cases = [
    [{ location: "accounts/1/locations/99", title: "Lucas Construction" }, /could not open/],
    [{ location: LUCAS_RES, title: "Lucas Construction LLC" }, /name is now "Lucas Construction"/],
    [{ location: "accounts/2/locations/12", title: "Lucas Construction" }, /not listed under accounts\/2/],
  ];
  for (const [pick, why] of cases) {
    const t = setup();
    const { status, body } = await t.post({ mode: "gbp_select", client_id: LUCAS, confirm: true, ...pick });
    assert.equal(status, 409, JSON.stringify(pick));
    assert.match(body.error, why);
    assert.deepEqual(t.sb.writes, [], JSON.stringify(pick));
    assert.equal(t.sb.db.clients.find((c) => c.id === LUCAS).gbp_location, null);
    assert.deepEqual(googleWrites(t.g.calls), []);
  }
});

test("an existing clients.gbp_location is never overwritten", async () => {
  const t = setup({ lucasLocation: "accounts/1/locations/11" });
  const { status, body } = await t.post({ mode: "gbp_select", client_id: LUCAS, location: LUCAS_RES, title: "Lucas Construction", confirm: true });
  assert.equal(status, 409);
  assert.match(body.error, /never overwritten/);
  assert.equal(t.sb.db.clients.find((c) => c.id === LUCAS).gbp_location, "accounts/1/locations/11");
  assert.deepEqual(t.sb.writes, []);
  assert.deepEqual(t.g.calls, [], "refused before any Google call");

  const same = setup({ lucasLocation: LUCAS_RES });
  const again = await same.post({ mode: "gbp_select", client_id: LUCAS, location: LUCAS_RES, title: "Lucas Construction", confirm: true });
  assert.equal(again.status, 200);
  assert.equal(again.body.unchanged, true);
  assert.deepEqual(same.sb.writes, []);
});

test("a concurrent save loses cleanly: the guarded update matches nothing and reports it", async () => {
  const t = setup();
  // Someone sets it between the read and the update.
  const origFrom = t.sb.from;
  let reads = 0;
  t.sb.from = (table) => {
    const b = origFrom(table);
    if (table === "clients") {
      const orig = b.maybeSingle;
      b.maybeSingle = async () => {
        const r = await orig();
        if (++reads === 1) t.sb.db.clients.find((c) => c.id === LUCAS).gbp_location = "accounts/1/locations/11";
        return r;
      };
    }
    return b;
  };
  const { status, body } = await t.post({ mode: "gbp_select", client_id: LUCAS, location: LUCAS_RES, title: "Lucas Construction", confirm: true });
  assert.equal(status, 409);
  assert.match(body.error, /Nothing was overwritten/);
  assert.equal(t.sb.db.clients.find((c) => c.id === LUCAS).gbp_location, "accounts/1/locations/11");
});

// ── Access report and Search Console ─────────────────────────────────────────
test("Check access reports without writing clients, and still reads Search Console with the GSC token", async () => {
  const t = setup();
  const { body } = await t.post({ mode: "access" });
  assert.equal(body.clients.find((c) => c.id === LUCAS).gbp, "yes");
  assert.equal(body.clients.find((c) => c.id === LUCAS).gsc, "yes");
  assert.deepEqual(t.sb.writes.filter((w) => w.table === "clients"), []);
  assert.deepEqual(switchWrites(t.sb.writes), []);
  const refreshes = t.g.calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com/token")).map((c) => new URLSearchParams(c.body).get("refresh_token"));
  assert.deepEqual(refreshes.sort(), ["gsc-rt", "ops-rt"]);
  assert.deepEqual(googleWrites(t.g.calls), []);
});

test("the Search Console sync still authenticates with GSC_REFRESH_TOKEN only", async () => {
  const sb = fakeSupabase();
  const g = fakeGoogle();
  const res = await createGscSync({ supabase: sb, fetch: g.fetch })(new Request("https://fn.local/gsc-sync", {
    method: "POST", headers: { "x-cron-secret": "cron-secret", "content-type": "application/json" }, body: "{}",
  }));
  assert.equal(res.status, 202);
  const refreshes = g.calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com/token")).map((c) => new URLSearchParams(c.body).get("refresh_token"));
  assert.deepEqual(refreshes, ["gsc-rt"]);
});
