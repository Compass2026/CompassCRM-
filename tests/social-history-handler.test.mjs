// The social-history function's handler over a fake store and a fake Zernio
// (fictional data). The database's own rules (who may write, the natural
// key, Compass-origin detection, snapshots only on change, grounding
// isolation) are tested on the real schema by the sandbox's
// social_history.test.sql.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSocialHistory } from "../supabase/functions/social-history/handler.ts";
import { ACCOUNT, FAKE_KEY, OTHER_ACCOUNT, PAGE, PROFILE, fakeZernio, zPost } from "./fixtures/zernio-fake.mjs";

const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const OTHER_CLIENT = "00000000-0000-4000-8000-0000000000c2";
const ADMIN = "00000000-0000-4000-8000-00000000aa01";
const MEMBER = "00000000-0000-4000-8000-00000000aa02";
const NOW = () => new Date("2026-10-08T12:00:00Z");

function fakeStore(o = {}) {
  const s = {
    secrets: { ZERNIO_READ_API_KEY: FAKE_KEY, ...(o.secrets ?? {}) },
    accounts: o.accounts ?? [],                 // social_accounts rows
    imports: [],
    posts: new Map(),                           // platform_post_id → row
    snapshots: [],
    writes: [],                                 // every write call, in order
  };
  return {
    s,
    async secret(name) { return s.secrets[name] ?? null; },
    async caller(jwt) {
      return { "jwt-admin": { member: ADMIN, role: "admin" }, "jwt-member": { member: MEMBER, role: "member" }, "jwt-stranger": { member: null, role: null } }[jwt] ?? "none";
    },
    async client(id) {
      return { [CLIENT]: { id: CLIENT, name: "Fictional Roofing Co", status: "active" }, [OTHER_CLIENT]: { id: OTHER_CLIENT, name: "Gone Co", status: "offboarded" } }[id] ?? null;
    },
    async socialAccount(clientId) { return s.accounts.find((a) => a.client_id === clientId) ?? null; },
    async pageOwner(pageId, clientId) { return s.accounts.find((a) => a.external_account_id === pageId && a.client_id !== clientId)?.client_id ?? null; },
    async begin(a) {
      s.writes.push(["begin", a]);
      if (s.imports.some((i) => i.status === "running")) return { conflict: "running", message: "An import is already running for this account" };
      let acct = s.accounts.find((x) => x.client_id === a.clientId);
      if (!acct) { acct = { id: "acct-1", client_id: a.clientId, external_account_id: a.pageId, display_name: a.pageName }; s.accounts.push(acct); }
      const imp = { id: `imp-${s.imports.length + 1}`, status: "running", ...a, counts: { inserted: 0, updated: 0, unchanged: 0, metrics_captured: 0 } };
      s.imports.push(imp);
      return { import_id: imp.id, social_account_id: acct.id };
    },
    async record(importId, rows) {
      s.writes.push(["record", importId, rows.length]);
      if (rows.length > 50) throw new Error("p_posts is an array of at most 50 posts");
      const c = { inserted: 0, updated: 0, unchanged: 0, metrics_captured: 0 };
      for (const r of rows) {
        const prev = s.posts.get(r.platform_post_id);
        if (!prev) c.inserted++;
        else if (prev.copy !== r.copy) c.updated++;
        else c.unchanged++;
        s.posts.set(r.platform_post_id, r);
        if (r.metrics) {
          const last = s.snapshots.filter((x) => x.id === r.platform_post_id).at(-1);
          if (!last || JSON.stringify(last.m) !== JSON.stringify(r.metrics)) { s.snapshots.push({ id: r.platform_post_id, m: r.metrics }); c.metrics_captured++; }
        }
      }
      const imp = s.imports.find((i) => i.id === importId);
      for (const k of Object.keys(c)) imp.counts[k] += c[k];
      return c;
    },
    async finish(importId, status, error, listing) {
      s.writes.push(["finish", importId, status]);
      Object.assign(s.imports.find((i) => i.id === importId), { status, error, listing });
      return {};
    },
  };
}

function setup(o = {}) {
  const store = fakeStore(o.store);
  const z = fakeZernio(o.zernio);
  const pending = [];
  const fn = createSocialHistory({ store, fetch: z.fetch, now: NOW, sleep: async () => {}, waitUntil: (p) => pending.push(p) });
  const call = async (body, jwt = "jwt-admin") => {
    const res = await fn.handle(new Request("https://fn.example/social-history", {
      method: "POST", headers: { Authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() };
  };
  return { store, z, call, settle: () => Promise.all(pending) };
}

test("callers: no sign-in 401, a non-team sign-in 403, import is admin-only", async () => {
  const { call } = setup();
  assert.equal((await call({ mode: "version" }, "")).status, 401);
  assert.equal((await call({ mode: "version" }, "jwt-stranger")).status, 403);
  const v = await call({ mode: "version" }, "jwt-member");
  assert.equal(v.status, 200);
  assert.equal(v.body.key_present, true);
  assert.deepEqual(v.body.zernio.methods, ["GET"]);
  assert.ok(!JSON.stringify(v.body).includes(FAKE_KEY), "the key is never returned");
  const imp = await call({ mode: "import", client_id: CLIENT, account_id: ACCOUNT, page_id: PAGE }, "jwt-member");
  assert.equal(imp.status, 403);
  assert.equal(imp.body.error, "admin_only");
});

test("plan is a dry run: a 20-post sample, Zernio's objects beside what would be stored, and no write at all", async () => {
  const { call, store, z } = setup();
  const r = await call({ mode: "plan", client_id: CLIENT }, "jwt-member");
  assert.equal(r.status, 200);
  assert.equal(r.body.writes, "none");
  assert.equal(store.s.writes.length, 0, "plan never writes");
  assert.equal(z.violations.length, 0);
  assert.ok(z.requests.every((q) => q.method === "GET"));
  assert.equal(r.body.posts.length, 20);
  assert.equal(r.body.posts[0].zernio._id, "ext000000000000000000001");
  assert.equal(r.body.posts[0].would_store.platform_post_id, `${PAGE}_9001`);
  assert.equal(r.body.account.id, ACCOUNT);
  assert.deepEqual(r.body.page, { id: PAGE, name: "Fictional Roofing Co", selected_page_id: PAGE, platform_user_id: PAGE, account_page_id: PAGE, match: true, recorded_for_client: null });
  assert.deepEqual(r.body.key.visible_profiles, [{ id: PROFILE, name: "Compass – Fictional Roofing", account_count: 1 }]);
  assert.equal(r.body.listing.available, 30);
  assert.equal(r.body.field_quality.mappable, 20);
  assert.deepEqual(r.body.blockers, []);
  assert.deepEqual(r.body.import_request, { mode: "import", client_id: CLIENT, account_id: ACCOUNT, page_id: PAGE, limit: 30 });
  assert.ok(!JSON.stringify(r.body).includes(FAKE_KEY));
  assert.equal((await call({ mode: "plan", client_id: CLIENT, sample: 26 })).status, 400);
});

test("plan never picks one of several accounts, and refuses a Page recorded for another client", async () => {
  const two = [
    { _id: ACCOUNT, platform: "facebook", platformUserId: PAGE, displayName: "Fictional Roofing Co" },
    { _id: OTHER_ACCOUNT, platform: "facebook", platformUserId: "999888777666555", displayName: "Someone Else" },
  ];
  const amb = setup({ zernio: { accounts: two } });
  const r = await amb.call({ mode: "plan", client_id: CLIENT });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "account_ambiguous");
  assert.equal(r.body.visible.length, 2);
  const named = await amb.call({ mode: "plan", client_id: CLIENT, account_id: ACCOUNT });
  assert.equal(named.status, 200);

  const taken = setup({ store: { accounts: [{ id: "acct-x", client_id: OTHER_CLIENT, external_account_id: PAGE }] } });
  const t = await taken.call({ mode: "plan", client_id: CLIENT });
  assert.equal(t.status, 200);
  assert.ok(t.body.blockers.some((b) => /another client/.test(b)));
  assert.equal(t.body.import_request, null);
});

test("plan without the key, with a rejected key, or without analytics access says so", async () => {
  const none = setup({ store: { secrets: { ZERNIO_READ_API_KEY: null } } });
  const n = await none.call({ mode: "plan", client_id: CLIENT });
  assert.equal(n.status, 424);
  assert.deepEqual(n.body, { error: "zernio_key_missing", secret: "ZERNIO_READ_API_KEY" });
  const bad = setup({ zernio: { key: "sk_" + "9".repeat(64) } });
  const b = await bad.call({ mode: "plan", client_id: CLIENT });
  assert.equal(b.status, 424);
  assert.equal(b.body.error, "zernio_key_rejected");
  const noAnalytics = setup({ zernio: { hasAnalyticsAccess: false } });
  const a = await noAnalytics.call({ mode: "plan", client_id: CLIENT });
  assert.ok(a.body.blockers.some((x) => /analytics access/.test(x)));
});

test("import is bound to the plan's account and Page, records in batches and finishes completed", async () => {
  const { call, store, z, settle } = setup({ zernio: { posts: Array.from({ length: 60 }, (_, i) => zPost(i + 1)) } });
  const wrongPage = await call({ mode: "import", client_id: CLIENT, account_id: ACCOUNT, page_id: "123456789" });
  assert.equal(wrongPage.status, 409);
  assert.equal(wrongPage.body.error, "page_mismatch");
  assert.equal(store.s.writes.length, 0);

  const r = await call({ mode: "import", client_id: CLIENT, account_id: ACCOUNT, page_id: PAGE, limit: 50 });
  assert.equal(r.status, 202);
  await settle();
  const imp = store.s.imports[0];
  assert.equal(imp.status, "completed");
  assert.deepEqual(imp.counts, { inserted: 50, updated: 0, unchanged: 0, metrics_captured: 50 });
  assert.deepEqual(store.s.writes.filter((w) => w[0] === "record").map((w) => w[2]), [25, 25]);
  assert.equal(imp.listing.complete, true);
  assert.equal(imp.listing.oldest_seen, "2026-08-18T15:00:00.000Z");
  assert.equal(imp.pageName, "Fictional Roofing Co");
  assert.equal(imp.requestedBy, ADMIN);
  assert.equal(z.violations.length, 0);
  assert.ok(z.requests.every((q) => q.method === "GET"));
  const analytics = z.requests.filter((q) => q.path === "/api/v1/analytics");
  assert.deepEqual(analytics.map((q) => [q.query.page, q.query.limit, q.query.fromDate]), [["1", "50", "2025-10-08"]]);
});

test("re-importing is a no-op; changed copy and changed metrics are the only updates", async () => {
  const posts = Array.from({ length: 5 }, (_, i) => zPost(i + 1));
  const a = setup({ zernio: { posts } });
  await a.call({ mode: "import", client_id: CLIENT, account_id: ACCOUNT, page_id: PAGE, limit: 5 });
  await a.settle();
  // Second and third runs over the same store.
  let pending;
  const run = async () => {
    const res = await createSocialHistory({ store: a.store, fetch: a.z.fetch, now: NOW, waitUntil: (p) => { pending = p; } })
      .handle(new Request("https://fn.example", { method: "POST", headers: { Authorization: "Bearer jwt-admin" },
        body: JSON.stringify({ mode: "import", client_id: CLIENT, account_id: ACCOUNT, page_id: PAGE, limit: 5 }) }));
    await pending;
    return res.status;
  };
  assert.equal(await run(), 202);
  assert.deepEqual(a.store.s.imports[1].counts, { inserted: 0, updated: 0, unchanged: 5, metrics_captured: 0 });
  posts[0].content = "Edited on Facebook after posting.";
  posts[1].platforms[0].analytics = { ...posts[1].platforms[0].analytics, likes: 99 };
  assert.equal(await run(), 202);
  assert.deepEqual(a.store.s.imports[2].counts, { inserted: 0, updated: 1, unchanged: 4, metrics_captured: 1 });
});

test("a long rate limit before anything is recorded fails the import; a second running import is refused", async () => {
  const { call, store, settle } = setup({ zernio: { posts: Array.from({ length: 150 }, (_, i) => zPost(i + 1)), rateLimitOnPage: 2, retryAfter: 600 } });
  assert.equal((await call({ mode: "import", client_id: CLIENT, account_id: ACCOUNT, page_id: PAGE, limit: 100 })).status, 202);
  await settle();
  // limit 100 fits on page 1, so no second page is read.
  assert.equal(store.s.imports[0].status, "completed");

  const s2 = setup({ zernio: { posts: Array.from({ length: 150 }, (_, i) => zPost(i + 1)), rateLimitOnPage: 1, retryAfter: 600 } });
  assert.equal((await s2.call({ mode: "import", client_id: CLIENT, account_id: ACCOUNT, page_id: PAGE })).status, 202);
  await s2.settle();
  assert.equal(s2.store.s.imports[0].status, "failed", "nothing recorded, so failed rather than partial");
  assert.match(s2.store.s.imports[0].error, /Zernio 429/);

  s2.store.s.imports.push({ id: "imp-running", status: "running", counts: {} });
  const busy = await s2.call({ mode: "import", client_id: CLIENT, account_id: ACCOUNT, page_id: PAGE });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error, "import_running");
});

test("partial: a transient failure after some posts were recorded", async () => {
  // Zernio answering 10 per page (as if it capped the page size), and the
  // connection dropping on page 2.
  const store = fakeStore();
  const z = fakeZernio({ posts: Array.from({ length: 30 }, (_, i) => zPost(i + 1)) });
  let analyticsCalls = 0;
  const tenPerPage = async (req) => {
    const u = new URL(req.url);
    if (u.pathname.endsWith("/v1/analytics")) {
      if (++analyticsCalls === 2) throw new TypeError("connection reset");
      u.searchParams.set("limit", "10");
    }
    return z.fetch(new Request(u, { method: "GET", headers: req.headers }));
  };
  const { createZernioReader } = await import("../supabase/functions/social-history/zernio.ts");
  const fn = createSocialHistory({ store, fetch: tenPerPage, now: NOW });
  store.s.imports.push({ id: "imp-1", status: "running", counts: { inserted: 0, updated: 0, unchanged: 0, metrics_captured: 0 } });
  await fn.execute(createZernioReader({ apiKey: FAKE_KEY, fetch: tenPerPage }), "imp-1", ACCOUNT, 100);
  const imp = store.s.imports[0];
  assert.equal(imp.status, "partial");
  assert.equal(imp.counts.inserted, 10);
  assert.equal(imp.listing.complete, false);
  assert.match(imp.error, /did not answer/);
});

test("an offboarded or unknown client and unexpected fields are refused", async () => {
  const { call } = setup();
  assert.equal((await call({ mode: "plan", client_id: OTHER_CLIENT })).status, 409);
  assert.equal((await call({ mode: "plan", client_id: "00000000-0000-4000-8000-000000000999" })).status, 404);
  assert.equal((await call({ mode: "plan", client_id: CLIENT, copy: "x" })).status, 400);
  assert.equal((await call({ mode: "publish", client_id: CLIENT })).status, 400);
});

test("a Facebook platformUserId of the form <user>:page:<page> resolves to the Page (real Lucas shape, Oct 8 2026)", async () => {
  const { pageIdOf } = await import("../supabase/functions/social-history/handler.ts");
  assert.equal(pageIdOf("1083389328003208:page:103977857788955"), "103977857788955");
  assert.equal(pageIdOf("103977857788955"), "103977857788955");
  assert.equal(pageIdOf("abc:page:x"), null);
  assert.equal(pageIdOf(null), null);
  const composite = [{ _id: ACCOUNT, platform: "facebook", platformUserId: `1083389328003208:page:${PAGE}`, displayName: "Fictional Roofing Co" }];
  const { call } = setup({ zernio: { accounts: composite } });
  const r = await call({ mode: "plan", client_id: CLIENT });
  assert.equal(r.status, 200);
  assert.equal(r.body.page.id, PAGE);
  assert.equal(r.body.page.match, true);
  assert.deepEqual(r.body.blockers, []);
  assert.equal(r.body.import_request.page_id, PAGE);
  // A recorded Page is matched against the composite id too.
  const rec = setup({ zernio: { accounts: composite }, store: { accounts: [{ id: "acct-1", client_id: CLIENT, external_account_id: PAGE }] } });
  assert.equal((await rec.call({ mode: "plan", client_id: CLIENT })).status, 200);
});
