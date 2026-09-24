// The post publisher's handler (0046) with an in-memory store and a fake
// Google Business Profile API. The real database behaviour (0045 triggers,
// the service-role publisher identity) is covered end to end by
// tests/publisher-integration.mjs over PostgREST.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostPublisher } from "../supabase/functions/post-publisher/handler.ts";

const CA = "00000000-0000-4000-8000-0000000000c1";
const CB = "00000000-0000-4000-8000-0000000000c2";
const NOW = new Date("2026-09-24T15:00:00.000Z");
const LOC = "accounts/111/locations/222";

const snapshot = (o = {}) => ({
  platform: "google_business", post_type: "standard", copy: "Slow drains? We clear them the same week.",
  cta_type: "LEARN_MORE", cta_url: "https://a.example.test/drains", offer: null, assets: [], ...o,
});

function post(id, o = {}) {
  const snap = snapshot(o.snapshot);
  return {
    id, client_id: CA, platform: snap.platform, copy: snap.copy, review_status: "approved", publish_status: "scheduled",
    scheduled_at: "2026-09-24T14:00:00.000Z", publish_attempts: 0, last_attempt_at: null,
    approved_snapshot: snap, external_post_id: null, published_url: null, published_at: null, error: null,
    ...o, snapshot: undefined,
  };
}

function fakeStore({ posts = [], settings = { enabled: true, clients: [CA] }, secrets = {}, clients = {}, claimErrors = {} } = {}) {
  const s = {
    posts: new Map(posts.map((p) => [p.id, { ...p }])),
    runs: [], tasks: [], settings,
    clients: { [CA]: { id: CA, name: "Harbor Lane Plumbing", dba: null, phone: "(417) 555-0100", gbp_location: LOC }, [CB]: { id: CB, name: "Summit Electric", dba: null, phone: null, gbp_location: null }, ...clients },
    secrets: { SYNC_CRON_SECRET: "cron", GSC_CLIENT_ID: "cid", GSC_CLIENT_SECRET: "csec", GOOGLE_OPS_REFRESH_TOKEN: "rt", ...secrets },
    claimErrors, rechecked: [], signed: [],
  };
  const list = (f) => [...s.posts.values()].filter(f).map((p) => ({ ...p }));
  const store = {
    secret: async (n) => s.secrets[n] ?? null,
    teamMemberForJwt: async (jwt) => (jwt === "team-jwt" ? "tm-1" : null),
    settings: async () => s.settings,
    post: async (id) => (s.posts.has(id) ? { ...s.posts.get(id) } : null),
    dueGbpPosts: async (nowIso, limit) => list((p) => p.platform === "google_business" && p.publish_status === "scheduled" && p.review_status === "approved" && p.scheduled_at <= nowIso).sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at)).slice(0, limit),
    stuckGbpPosts: async (before) => list((p) => p.platform === "google_business" && p.publish_status === "publishing" && p.last_attempt_at <= before),
    failedGbpPosts: async () => list((p) => p.platform === "google_business" && p.publish_status === "failed"),
    dueHandPosts: async (nowIso) => list((p) => p.platform !== "google_business" && p.publish_status === "scheduled" && p.review_status === "approved" && p.scheduled_at <= nowIso),
    openReminders: async () => s.runs.filter((r) => r.outcome === "reminder_opened").map((r) => ({ post_id: r.post_id, client_id: r.client_id, task_id: r.task_id })),
    hasReminder: async (id) => s.runs.some((r) => r.post_id === id && r.outcome === "reminder_opened"),
    hasClosedReminder: async (id) => s.runs.some((r) => r.post_id === id && r.outcome === "reminder_closed"),
    latestRun: async (id) => [...s.runs].reverse().find((r) => r.post_id === id) ?? null,
    client: async (id) => s.clients[id] ?? null,
    setGbpLocation: async (id, v) => { s.clients[id].gbp_location = v; },
    claim: async (id) => {
      const p = s.posts.get(id);
      if (s.claimErrors[id]) return { ok: false, error: s.claimErrors[id] };
      if (!p || p.publish_status !== "scheduled") return { ok: false, error: null };
      p.publish_status = "publishing"; p.publish_attempts += 1; p.last_attempt_at = NOW.toISOString(); p.error = null;
      return { ok: true, row: { ...p } };
    },
    markPublished: async (id, v) => {
      const p = s.posts.get(id);
      assert.equal(p.publish_status, "publishing", "only a claimed post is recorded published");
      Object.assign(p, { publish_status: "published" }, v);
    },
    markFailed: async (id, msg) => { const p = s.posts.get(id); assert.equal(p.publish_status, "publishing"); Object.assign(p, { publish_status: "failed", error: msg }); },
    retry: async (id) => { const p = s.posts.get(id); if (p.publish_status !== "failed") return false; p.publish_status = "scheduled"; return true; },
    unschedule: async (id) => { const p = s.posts.get(id); if (p.publish_status === "scheduled") p.publish_status = "not_scheduled"; },
    recheck: async (id) => { s.rechecked.push(id); },
    insertRun: async (r) => { s.runs.push({ transient: false, ...r }); },
    openTask: async (t) => {
      const hit = s.tasks.find((x) => x.client_id === t.client_id && x.key === t.key && x.status !== "done" && (!t.post_id || x.notes.includes(`post_id=${t.post_id}`)));
      if (hit) return hit.id;
      const task = { id: `task-${s.tasks.length + 1}`, status: "open", owner: "TOM", ...t };
      s.tasks.push(task);
      return task.id;
    },
    closeTask: async (id, outcome) => { const t = s.tasks.find((x) => x.id === id); if (t) { t.status = "done"; t.closed_with = outcome; } },
    signPhoto: async (path) => { s.signed.push(path); return `https://storage.example/signed/${path}?token=t`; },
  };
  return { store, s };
}

// A fake Google: token, accounts / locations, location check, posts list and create.
function fakeGoogle({ token = true, access = true, accounts = [], created = [], existing = [] } = {}) {
  const g = { calls: [], createBodies: [], createResponses: [...created], existing: [...existing] };
  g.fetch = async (url, init = {}) => {
    const u = String(url);
    g.calls.push(`${init.method ?? "GET"} ${u.replace(/\?.*/, "")}`);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.startsWith("https://oauth2.googleapis.com/token")) return token ? json(200, { access_token: "at" }) : json(400, { error: "invalid_grant" });
    if (u.includes("/v1/accounts?")) return json(200, { accounts: accounts.map((a) => ({ name: a.name })) });
    if (u.includes("/v1/accounts/") && u.includes("/locations?")) {
      const a = accounts.find((x) => u.includes(`/${x.name}/locations`));
      return json(200, { locations: a?.locations ?? [] });
    }
    if (u.includes("mybusinessbusinessinformation") && u.includes("/v1/locations/")) {
      return access ? json(200, { name: "locations/222", metadata: { mapsUri: "https://maps.example/harbor" } }) : json(403, { error: { message: "The caller does not have permission" } });
    }
    if (u.includes("/localPosts") && (init.method ?? "GET") === "GET") return json(200, { localPosts: g.existing });
    if (u.includes("/localPosts") && init.method === "POST") {
      g.createBodies.push(JSON.parse(init.body));
      const next = g.createResponses.shift() ?? { status: 200, body: { name: `${LOC}/localPosts/p${g.createBodies.length}`, searchUrl: `https://g.example/p${g.createBodies.length}`, createTime: NOW.toISOString() } };
      if (next.throw) throw new Error(next.throw);
      return json(next.status, next.body);
    }
    return json(404, { error: { message: `unexpected ${u}` } });
  };
  return g;
}

const setup = (storeOpts, googleOpts) => {
  const { store, s } = fakeStore(storeOpts);
  const g = fakeGoogle(googleOpts);
  const pub = createPostPublisher({ store, fetch: g.fetch, now: () => NOW, googleTimeoutMs: 200 });
  return { pub, s, g };
};

test("a due, approved post is published from its snapshot and recorded", async () => {
  const { pub, s, g } = setup({ posts: [post("p1", { snapshot: { assets: [{ id: "a1", storage_path: `${CA}/photos/drain.jpg`, url: null, sort_order: 1 }] } })] });
  const r = await pub.tick({ mode: "tick" });
  const p = s.posts.get("p1");
  assert.equal(p.publish_status, "published");
  assert.equal(p.external_post_id, `${LOC}/localPosts/p1`);
  assert.equal(p.published_url, "https://g.example/p1");
  assert.equal(g.createBodies.length, 1);
  assert.deepEqual(g.createBodies[0].media, [{ mediaFormat: "PHOTO", sourceUrl: `https://storage.example/signed/${CA}/photos/drain.jpg?token=t` }]);
  assert.equal(g.createBodies[0].summary, "Slow drains? We clear them the same week.");
  assert.deepEqual(s.runs.map((x) => x.outcome), ["published"]);
  assert.deepEqual(r.results.map((x) => x.outcome), ["published"]);
});

test("the live row is never sent: only the approved snapshot", async () => {
  const p = post("p1");
  p.copy = "LIVE TEXT THAT WAS NEVER APPROVED";
  const { pub, g } = setup({ posts: [p] });
  await pub.tick({ mode: "tick" });
  assert.equal(g.createBodies[0].summary, "Slow drains? We clear them the same week.");
});

test("switch off: nothing is claimed or sent; Publish now records why", async () => {
  const { pub, s, g } = setup({ posts: [post("p1")], settings: { enabled: false, clients: [CA] } });
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "scheduled");
  assert.equal(g.calls.length, 0);
  await pub.tick({ mode: "now", postId: "p1" });
  assert.match(s.runs.at(-1).detail, /switched off/);
});

test("a client off the pilot list is blocked once, not every tick", async () => {
  const other = post("p2", { client_id: CB });
  const { pub, s, g } = setup({ posts: [other] });
  await pub.tick({ mode: "tick" });
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p2").publish_status, "scheduled");
  assert.equal(s.runs.filter((r) => r.outcome === "blocked").length, 1);
  assert.match(s.runs[0].detail, /pilot list/);
  assert.equal(g.createBodies.length, 0);
});

test("a snapshot Google would refuse is unscheduled with a TOM task, never sent", async () => {
  const { pub, s, g } = setup({ posts: [post("p1", { snapshot: { copy: "x".repeat(1600) } })] });
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "not_scheduled");
  assert.equal(g.calls.length, 0, "no Google call for a preflight failure");
  const run = s.runs[0];
  assert.equal(run.outcome, "blocked");
  assert.match(run.detail, /at most 1500 characters/);
  const task = s.tasks.find((t) => t.id === run.task_id);
  assert.equal(task.key, "publisher_fix_post");
  assert.equal(task.owner, "TOM");
});

test("Google not connected: the post stays scheduled, one task per client, one run per post", async () => {
  const { pub, s } = setup({ posts: [post("p1")], secrets: { GOOGLE_OPS_REFRESH_TOKEN: null } });
  await pub.tick({ mode: "tick" });
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "scheduled");
  assert.equal(s.runs.length, 1);
  assert.match(s.runs[0].detail, /GOOGLE_OPS_REFRESH_TOKEN/);
  assert.equal(s.tasks.filter((t) => t.key === "publisher_connect_google").length, 1);
});

test("no profile access: blocked with the access task; nothing claimed", async () => {
  const { pub, s } = setup({ posts: [post("p1")] }, { access: false });
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "scheduled");
  assert.match(s.runs[0].detail, /manager access/);
  assert.equal(s.tasks[0].key, "publisher_profile_access");
});

test("the profile is found by phone and remembered", async () => {
  const noLoc = { [CA]: { id: CA, name: "Harbor Lane Plumbing", dba: null, phone: "(417) 555-0100", gbp_location: null } };
  const { pub, s } = setup({ posts: [post("p1")], clients: noLoc }, {
    accounts: [{ name: "accounts/111", locations: [{ name: "locations/999", title: "Other", phoneNumbers: { primaryPhone: "555" } }, { name: "locations/222", title: "Harbor Lane", phoneNumbers: { primaryPhone: "+1 417-555-0100" } }] }],
  });
  await pub.tick({ mode: "tick" });
  assert.equal(s.clients[CA].gbp_location, LOC);
  assert.equal(s.posts.get("p1").publish_status, "published");
});

test("a refused claim (support changed) is rechecked and recorded as lapsed", async () => {
  const { pub, s, g } = setup({ posts: [post("p1")], claimErrors: { p1: "The post changed since it was approved; it goes back to review" } });
  await pub.tick({ mode: "tick" });
  assert.deepEqual(s.rechecked, ["p1"]);
  assert.equal(s.runs[0].outcome, "lapsed");
  assert.equal(g.createBodies.length, 0);
});

test("4xx is final: failed, a TOM task, no automatic retry", async () => {
  const { store, s } = fakeStore({ posts: [post("p1")] });
  const g = fakeGoogle({ created: [{ status: 400, body: { error: { message: "Invalid argument: summary" } } }] });
  let clock = NOW;
  const pub = createPostPublisher({ store, fetch: g.fetch, now: () => clock, googleTimeoutMs: 200 });
  await pub.tick({ mode: "tick" });
  const p = s.posts.get("p1");
  assert.equal(p.publish_status, "failed");
  assert.match(p.error, /Google 400: Invalid argument/);
  assert.equal(s.runs[0].transient, false);
  assert.equal(s.tasks[0].key, "publisher_failed");
  // A day later: still not retried.
  clock = new Date(NOW.getTime() + 24 * 60 * 60_000);
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "failed");
  assert.equal(g.createBodies.length, 1);
});

test("transient failures retry with backoff, check Google first, and stop at three attempts", async () => {
  let clock = new Date(NOW);
  const { store, s } = fakeStore({ posts: [post("p1")] });
  const g = fakeGoogle({ created: [{ status: 503, body: { error: { message: "backend" } } }, { throw: "network down" }, { status: 500, body: { error: { message: "internal" } } }] });
  const pub = createPostPublisher({ store, fetch: g.fetch, now: () => clock, googleTimeoutMs: 200 });
  // The fake claim stamps NOW; move it with the clock.
  const claim = store.claim;
  store.claim = async (id) => { const r = await claim(id); if (r.ok) { s.posts.get(id).last_attempt_at = clock.toISOString(); r.row.last_attempt_at = clock.toISOString(); } return r; };

  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "failed");
  assert.equal(s.runs.at(-1).transient, true);
  assert.equal(s.tasks.length, 0, "no task for a transient failure under the cap");

  clock = new Date(NOW.getTime() + 5 * 60_000);
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "failed", "backoff: not before 10 minutes");

  clock = new Date(NOW.getTime() + 11 * 60_000);
  await pub.tick({ mode: "tick" });
  assert.deepEqual(s.runs.slice(-2).map((r) => r.outcome), ["retry_scheduled", "failed"]);
  assert.ok(g.calls.some((c) => c.startsWith("GET") && c.includes("/localPosts")), "Google was checked before re-sending");
  assert.equal(s.posts.get("p1").publish_attempts, 2);

  clock = new Date(clock.getTime() + 31 * 60_000);
  await pub.tick({ mode: "tick" });
  const p = s.posts.get("p1");
  assert.equal(p.publish_attempts, 3);
  assert.equal(p.publish_status, "failed");
  assert.equal(s.tasks.filter((t) => t.key === "publisher_failed").length, 1, "the third failure goes to a person");

  clock = new Date(clock.getTime() + 24 * 60 * 60_000);
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_attempts, 3, "no fourth automatic attempt");
  assert.equal(g.createBodies.length, 3);
});

test("a retry finds the earlier attempt already on Google and does not send twice", async () => {
  const p = post("p1", { publish_status: "failed", publish_attempts: 1, last_attempt_at: "2026-09-24T14:30:00.000Z", error: "Google network error" });
  const { store, s } = fakeStore({ posts: [p] });
  s.runs.push({ post_id: "p1", client_id: CA, mode: "tick", outcome: "failed", transient: true });
  const g = fakeGoogle({ existing: [{ name: `${LOC}/localPosts/already`, summary: "Slow drains? We clear them the same week.", createTime: "2026-09-24T14:30:05Z", searchUrl: "https://g.example/already" }] });
  const pub = createPostPublisher({ store, fetch: g.fetch, now: () => NOW, googleTimeoutMs: 200 });
  await pub.tick({ mode: "tick" });
  const row = s.posts.get("p1");
  assert.equal(row.publish_status, "published");
  assert.equal(row.external_post_id, `${LOC}/localPosts/already`);
  assert.equal(g.createBodies.length, 0);
  assert.equal(s.runs.at(-1).outcome, "reconciled");
});

test("a post stuck in publishing is reconciled or failed safely", async () => {
  const stuck = post("p1", { publish_status: "publishing", publish_attempts: 1, last_attempt_at: "2026-09-24T14:40:00.000Z" });
  const a = setup({ posts: [stuck] }, { existing: [{ name: `${LOC}/localPosts/x`, summary: "Slow drains? We clear them the same week.", createTime: "2026-09-24T14:40:02Z" }] });
  await a.pub.tick({ mode: "tick" });
  assert.equal(a.s.posts.get("p1").publish_status, "published");
  assert.equal(a.s.posts.get("p1").published_url, "https://maps.example/harbor", "falls back to the profile's Maps link");
  assert.equal(a.s.runs[0].outcome, "reconciled");

  // Nothing on Google: failed as transient, and (its backoff already
  // passed) retried in the same tick after checking Google again.
  const b = setup({ posts: [{ ...stuck }] });
  await b.pub.tick({ mode: "tick" });
  assert.match(b.s.runs[0].detail, /No confirmation from Google/);
  assert.equal(b.s.runs[0].transient, true);
  assert.deepEqual(b.s.runs.map((r) => r.outcome), ["failed", "retry_scheduled", "published"]);
  assert.equal(b.s.posts.get("p1").publish_attempts, 2);
  assert.equal(b.g.calls.filter((c) => c.startsWith("GET") && c.includes("/localPosts")).length, 2, "checked before failing and before re-sending");
});

test("at most five posts per tick and one per location", async () => {
  const posts = Array.from({ length: 3 }, (_, i) => post(`p${i}`, { scheduled_at: `2026-09-24T1${i}:00:00.000Z` }));
  const { pub, s, g } = setup({ posts });
  await pub.tick({ mode: "tick" });
  assert.equal(g.createBodies.length, 1, "one post per location per tick");
  assert.equal(s.posts.get("p0").publish_status, "published", "oldest first");
  assert.equal(s.posts.get("p1").publish_status, "scheduled");
});

test("Publish now takes the same path, only for the post asked for", async () => {
  const { pub, s, g } = setup({ posts: [post("p1"), post("p2", { scheduled_at: "2026-09-24T13:00:00.000Z" })] });
  const r = await pub.tick({ mode: "now", postId: "p1" });
  assert.equal(s.posts.get("p1").publish_status, "published");
  assert.equal(s.posts.get("p2").publish_status, "scheduled", "nothing else is touched");
  assert.equal(s.runs[0].mode, "now");
  assert.equal(g.createBodies.length, 1);
  assert.deepEqual(r.results.map((x) => x.outcome), ["published"]);
  // A post that is not scheduled is not claimed.
  const again = await pub.tick({ mode: "now", postId: "p1" });
  assert.equal(again.results[0].outcome, "skipped");
});

test("the request boundary: cron ticks; a team member may only publish one post now", async () => {
  const { pub } = setup({ posts: [post("p1")] });
  const call = (headers, body) => pub.handle(new Request("https://fn.local/post-publisher", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  assert.equal((await call({}, { mode: "tick" })).status, 401);
  assert.equal((await call({ Authorization: "Bearer stranger" }, { mode: "now", post_id: "p1" })).status, 403);
  assert.equal((await call({ Authorization: "Bearer team-jwt" }, { mode: "tick" })).status, 400, "a person cannot run the whole tick");
  assert.equal((await call({ Authorization: "Bearer team-jwt" }, { mode: "now", post_id: "p1", copy: "injected" })).status, 200);
  const res = await call({ "x-cron-secret": "cron" }, { mode: "tick" });
  assert.equal(res.status, 200);
});

test("a non-Business-Profile post due now gets one TOM task to post it by hand, closed once marked published", async () => {
  const fb = post("f1", { platform: "facebook", snapshot: { platform: "facebook" } });
  const { pub, s, g } = setup({ posts: [fb] });
  await pub.tick({ mode: "tick" });
  await pub.tick({ mode: "tick" });
  assert.equal(s.tasks.length, 1);
  assert.equal(s.tasks[0].key, "post_by_hand");
  assert.match(s.tasks[0].title, /^Post this by hand: Facebook/);
  assert.equal(s.runs.filter((r) => r.outcome === "reminder_opened").length, 1);
  assert.equal(g.createBodies.length, 0, "the publisher never posts to Facebook");
  s.posts.get("f1").publish_status = "published";
  await pub.tick({ mode: "tick" });
  assert.equal(s.tasks[0].status, "done");
  assert.equal(s.runs.at(-1).outcome, "reminder_closed");
  // Reminders run even with the publisher switched off.
  const off = setup({ posts: [post("f2", { platform: "instagram", snapshot: { platform: "instagram" } })], settings: { enabled: false, clients: [] } });
  await off.pub.tick({ mode: "tick" });
  assert.equal(off.s.tasks[0].key, "post_by_hand");
});
