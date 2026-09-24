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
    approved_snapshot: snap, reviewed_at: "2026-09-24T12:00:00.000Z", external_post_id: null, published_url: null, published_at: null, error: null,
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
  const reminderState = () => {
    const latest = new Map();
    for (const r of s.runs) if (r.outcome === "reminder_opened" || r.outcome === "reminder_closed") latest.set(r.post_id, r);
    return [...latest.values()];
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
    // Same rule as publisher_reminder_state(): the latest reminder event per post.
    openReminders: async () => reminderState().filter((r) => r.outcome === "reminder_opened").map(({ post_id, client_id, task_id }) => ({ post_id, client_id, task_id })),
    reminderOpen: async (id) => reminderState().some((r) => r.post_id === id && r.outcome === "reminder_opened"),
    firstAttemptRunAt: async (id) => s.runs.find((r) => r.post_id === id && ["failed", "uncertain", "ambiguous"].includes(r.outcome))?.created_at ?? null,
    latestRun: async (id) => [...s.runs].reverse().find((r) => r.post_id === id) ?? null,
    client: async (id) => s.clients[id] ?? null,
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
    insertRun: async (r) => { s.runs.push({ transient: false, created_at: s.clock?.().toISOString() ?? NOW.toISOString(), ...r }); },
    openTask: async (t) => {
      const hit = s.tasks.find((x) => x.client_id === t.client_id && x.key === t.key && x.status !== "done" && (!t.post_id || x.notes.includes(`post_id=${t.post_id}`)));
      if (hit) return hit.id;
      const task = { id: `task-${s.tasks.length + 1}`, status: "open", owner: "TOM", ...t };
      s.tasks.push(task);
      return task.id;
    },
    closeTask: async (id, outcome) => { const t = s.tasks.find((x) => x.id === id); if (t && t.status !== "done") { t.status = "done"; t.closed_with = outcome; } },
    openTasks: async (keys) => s.tasks.filter((t) => keys.includes(t.key) && t.status !== "done").map(({ id, client_id, key }) => ({ id, client_id, key })),
    closeOpenTasks: async (f, outcome) => {
      const hit = s.tasks.filter((t) => f.keys.includes(t.key) && t.status !== "done" && (!f.client_id || t.client_id === f.client_id) && (!f.post_id || t.notes.includes(`post_id=${f.post_id}`)));
      for (const t of hit) { t.status = "done"; t.closed_with = outcome; }
      return hit.map((t) => t.id);
    },
    signPhoto: async (path) => { s.signed.push(path); return `https://storage.example/signed/${path}?token=t`; },
  };
  return { store, s };
}

// A fake Google: token, accounts / locations, location check, posts list and create.
function fakeGoogle({ token = true, access = true, accounts = [], created = [], existing = [], morePages = false } = {}) {
  const g = { calls: [], createBodies: [], createResponses: [...created], existing: [...existing], token, access, morePages };
  g.fetch = async (url, init = {}) => {
    const u = String(url);
    g.calls.push(`${init.method ?? "GET"} ${u.replace(/\?.*/, "")}`);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.startsWith("https://oauth2.googleapis.com/token")) return g.token ? json(200, { access_token: "at" }) : json(400, { error: "invalid_grant" });
    if (u.includes("/v1/accounts?")) return json(200, { accounts: accounts.map((a) => ({ name: a.name })) });
    if (u.includes("/v1/accounts/") && u.includes("/locations?")) {
      const a = accounts.find((x) => u.includes(`/${x.name}/locations`));
      return json(200, { locations: a?.locations ?? [] });
    }
    if (u.includes("mybusinessbusinessinformation") && u.includes("/v1/locations/")) {
      return g.access ? json(200, { name: "locations/222", metadata: { mapsUri: "https://maps.example/harbor" } }) : json(403, { error: { message: "The caller does not have permission" } });
    }
    if (u.includes("/localPosts") && (init.method ?? "GET") === "GET") {
      // With morePages, Google always says there is another page.
      return json(200, { localPosts: u.includes("pageToken=") ? [] : g.existing, ...(g.morePages ? { nextPageToken: "more" } : {}) });
    }
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

// A LocalPost as Google would list the default post created at `createTime`.
const onGoogle = (id, createTime, o = {}) => ({
  name: `${LOC}/localPosts/${id}`, summary: "Slow drains? We clear them the same week.", createTime, state: "LIVE",
  topicType: "STANDARD", callToAction: { actionType: "LEARN_MORE", url: "https://a.example.test/drains" }, languageCode: "en-US",
  searchUrl: `https://g.example/${id}`, ...o,
});

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

test("no selected location: GBP_LOCATION_REQUIRED; an exact phone + name match is never chosen or stored", async () => {
  const noLoc = { [CA]: { id: CA, name: "Harbor Lane Plumbing", dba: null, phone: "(417) 555-0100", gbp_location: null } };
  const { pub, s, g } = setup({ posts: [post("p1")], clients: noLoc }, {
    accounts: [{ name: "accounts/111", locations: [{ name: "locations/222", title: "Harbor Lane Plumbing", phoneNumbers: { primaryPhone: "+1 417-555-0100" } }] }],
  });
  await pub.tick({ mode: "tick" });
  assert.equal(s.clients[CA].gbp_location, null, "nothing stored");
  assert.equal(s.posts.get("p1").publish_status, "scheduled", "not claimed");
  assert.equal(s.runs[0].outcome, "blocked");
  assert.match(s.runs[0].detail, /^GBP_LOCATION_REQUIRED/);
  const task = s.tasks.find((t) => t.key === "publisher_select_location");
  assert.equal(task.status, "open");
  assert.equal(g.createBodies.length, 0);
  assert.ok(!g.calls.some((c) => c.includes("/v1/accounts")), "no discovery: the publisher does not search for a profile");

  // A person selects it (google-connect gbp_select); the next tick publishes and closes the task.
  s.clients[CA].gbp_location = LOC;
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "published");
  assert.equal(task.status, "done");
  assert.equal(s.clients[CA].gbp_location, LOC);
});

test("a selected gbp_location is used as is and never replaced", async () => {
  const { pub, s, g } = setup({ posts: [post("p1")] }, {
    accounts: [{ name: "accounts/999", locations: [{ name: "locations/1", title: "Harbor Lane Plumbing", phoneNumbers: { primaryPhone: "(417) 555-0100" } }] }],
  });
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "published");
  assert.equal(s.clients[CA].gbp_location, LOC);
  assert.ok(g.calls.some((c) => c.includes("/v1/locations/222")), "the selected location is checked");
  assert.ok(!g.calls.some((c) => c.includes("/v1/accounts")), "no search for another one");
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
  const g = fakeGoogle({ existing: [onGoogle("already", "2026-09-24T14:30:05Z")] });
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
  const a = setup({ posts: [stuck] }, { existing: [onGoogle("x", "2026-09-24T14:40:02Z", { searchUrl: undefined })] });
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

// ── Hardening (review of PR #60) ─────────────────────────────────────────────

test("hand-post reminders are cycles: unschedule closes one, rescheduling the same post opens a new one", async () => {
  const fb = post("f1", { platform: "facebook", snapshot: { platform: "facebook" } });
  const { pub, s } = setup({ posts: [fb] });
  const outcomes = () => s.runs.filter((r) => r.post_id === "f1").map((r) => r.outcome);

  await pub.tick({ mode: "tick" }); // due → opened
  assert.deepEqual(outcomes(), ["reminder_opened"]);
  const first = s.tasks[0];

  s.posts.get("f1").publish_status = "not_scheduled"; // a person unschedules
  await pub.tick({ mode: "tick" });
  assert.deepEqual(outcomes(), ["reminder_opened", "reminder_closed"]);
  assert.equal(first.status, "done");
  assert.match(first.closed_with, /No longer scheduled/);

  Object.assign(s.posts.get("f1"), { publish_status: "scheduled", scheduled_at: "2026-09-24T14:30:00.000Z" }); // rescheduled, due
  await pub.tick({ mode: "tick" });
  await pub.tick({ mode: "tick" });
  assert.deepEqual(outcomes(), ["reminder_opened", "reminder_closed", "reminder_opened"], "a new cycle, opened once");
  const open = s.tasks.filter((t) => t.key === "post_by_hand" && t.status !== "done");
  assert.equal(open.length, 1);
  assert.notEqual(open[0].id, first.id, "a fresh task, not the closed one");

  Object.assign(s.posts.get("f1"), { publish_status: "published", published_url: "https://facebook.example/p/1" }); // marked published
  await pub.tick({ mode: "tick" });
  assert.deepEqual(outcomes(), ["reminder_opened", "reminder_closed", "reminder_opened", "reminder_closed"]);
  assert.equal(open[0].status, "done");
  assert.match(open[0].closed_with, /Marked published/);
  await pub.tick({ mode: "tick" });
  assert.equal(outcomes().length, 4, "nothing more for a published post");
});

test("a reminder whose post was moved to a later time closes, and reopens when that time comes", async () => {
  const fb = post("f1", { platform: "linkedin", snapshot: { platform: "linkedin" } });
  const { store, s } = fakeStore({ posts: [fb] });
  let clock = NOW;
  const pub = createPostPublisher({ store, fetch: fakeGoogle().fetch, now: () => clock });
  await pub.tick({ mode: "tick" });
  s.posts.get("f1").scheduled_at = "2026-09-24T15:00:30+00:00"; // moved 30 s later, in PostgREST's format
  await pub.tick({ mode: "tick" });
  assert.match(s.runs.at(-1).detail, /Rescheduled for later/);
  clock = new Date("2026-09-24T15:01:00.000Z");
  await pub.tick({ mode: "tick" });
  assert.deepEqual(s.runs.map((r) => r.outcome), ["reminder_opened", "reminder_closed", "reminder_opened"]);
});

test("a 2xx that names no LocalPost is uncertain: nothing is recorded, then the profile decides", async () => {
  for (const body of [{}, { name: "" }, { name: "localPosts/abc" }, { searchUrl: "https://g.example/x" }]) {
    const { pub, s } = setup({ posts: [post("p1")] }, { created: [{ status: 200, body }] });
    await pub.tick({ mode: "tick" });
    const p = s.posts.get("p1");
    assert.equal(p.publish_status, "publishing", JSON.stringify(body));
    assert.equal(p.external_post_id, null);
    assert.equal(s.runs.at(-1).outcome, "uncertain");
  }

  // Ten minutes later exactly one safe match: reconciled with Google's name.
  const { store, s } = fakeStore({ posts: [post("p1")] });
  const g = fakeGoogle({ created: [{ status: 200, body: {} }] });
  let clock = NOW;
  const pub = createPostPublisher({ store, fetch: g.fetch, now: () => clock });
  await pub.tick({ mode: "tick" });
  g.existing = [onGoogle("real", "2026-09-24T15:00:01Z")];
  clock = new Date(NOW.getTime() + 11 * 60_000);
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "published");
  assert.equal(s.posts.get("p1").external_post_id, `${LOC}/localPosts/real`);
  assert.deepEqual(s.runs.map((r) => r.outcome), ["uncertain", "reconciled"]);
  assert.equal(g.createBodies.length, 1, "never sent twice");
});

test("an uncertain 2xx with nothing on the profile goes to a person, never re-sent", async () => {
  const { store, s } = fakeStore({ posts: [post("p1")] });
  const g = fakeGoogle({ created: [{ status: 200, body: {} }] });
  let clock = NOW;
  const pub = createPostPublisher({ store, fetch: g.fetch, now: () => clock });
  await pub.tick({ mode: "tick" });
  clock = new Date(NOW.getTime() + 11 * 60_000);
  await pub.tick({ mode: "tick" });
  clock = new Date(NOW.getTime() + 5 * 60 * 60_000);
  await pub.tick({ mode: "tick" });
  const p = s.posts.get("p1");
  assert.equal(p.publish_status, "failed");
  assert.equal(p.external_post_id, null);
  assert.deepEqual(s.runs.map((r) => r.outcome), ["uncertain", "ambiguous"], "no automatic retry after ambiguous");
  assert.match(s.runs[1].detail, /accepted the last attempt without naming the post/);
  assert.equal(s.tasks.filter((t) => t.key === "publisher_check_post").length, 1);
  assert.equal(g.createBodies.length, 1);
});

test("check before re-send: only exactly one safe match is reconciled; anything unclear goes to a person", async () => {
  const at = "2026-09-24T14:30:00.000Z";
  const failed = () => post("p1", { publish_status: "failed", publish_attempts: 1, last_attempt_at: at, error: "Google 503" });
  const attempt = (existing, o = {}) => {
    const { store, s } = fakeStore({ posts: [failed()] });
    s.runs.push({ post_id: "p1", client_id: CA, mode: "tick", outcome: "failed", transient: true });
    const g = fakeGoogle({ existing, ...o });
    return { pub: createPostPublisher({ store, fetch: g.fetch, now: () => NOW }), s, g };
  };
  const cases = [
    ["two identical posts since the attempt", [onGoogle("a", "2026-09-24T14:30:05Z"), onGoogle("b", "2026-09-24T14:31:00Z")], /2 exact matches/],
    ["same text, different button", [onGoogle("a", "2026-09-24T14:30:05Z", { callToAction: { actionType: "CALL" } })], /button CALL, expected LEARN_MORE/],
    ["same text, an offer instead of a standard post", [onGoogle("a", "2026-09-24T14:30:05Z", { topicType: "OFFER", callToAction: undefined, offer: { termsConditions: "10% off" } })], /topic OFFER, expected STANDARD/],
    ["same text, different link", [onGoogle("a", "2026-09-24T14:30:05Z", { callToAction: { actionType: "LEARN_MORE", url: "https://a.example.test/other" } })], /button link differs/],
    ["same text, no creation time", [onGoogle("a", undefined)], /no creation time/],
    ["same text, rejected by Google", [onGoogle("a", "2026-09-24T14:30:05Z", { state: "REJECTED" })], /rejected by Google/],
    ["one match plus an unconfirmable twin", [onGoogle("a", "2026-09-24T14:30:05Z"), onGoogle("b", "2026-09-24T14:31:00Z", { topicType: undefined })], /1 exact match.*could not be confirmed/],
  ];
  for (const [label, existing, why] of cases) {
    const { pub, s, g } = attempt(existing);
    await pub.tick({ mode: "tick" });
    const p = s.posts.get("p1");
    assert.equal(g.createBodies.length, 0, `${label}: not re-sent`);
    assert.equal(p.publish_status, "failed", `${label}: not recorded published`);
    assert.equal(s.runs.at(-1).outcome, "ambiguous", label);
    assert.match(s.runs.at(-1).detail, why, label);
    assert.equal(s.tasks.filter((t) => t.key === "publisher_check_post").length, 1, label);
  }

  // A list Google says is longer than what was read: not found ≠ not there.
  const long = attempt([], { morePages: true });
  await long.pub.tick({ mode: "tick" });
  assert.equal(long.g.createBodies.length, 0);
  assert.match(long.s.runs.at(-1).detail, /too long to check completely/);

  // An earlier, legitimate post with the same copy (before the attempt) is not ours: safe to send.
  const earlier = attempt([onGoogle("old", "2026-09-20T09:00:00Z")]);
  await earlier.pub.tick({ mode: "tick" });
  assert.equal(earlier.g.createBodies.length, 1);
  assert.equal(earlier.s.posts.get("p1").publish_status, "published");

  // An offer post matches on its terms, redeem link, title and dates.
  const offer = { id: "o1", title: "Fall special", terms: "$79 drain clearing", starts_on: "2026-10-01", ends_on: "2026-10-31" };
  const snap = { post_type: "offer", cta_type: null, offer };
  const { store, s } = fakeStore({ posts: [post("p1", { publish_status: "failed", publish_attempts: 1, last_attempt_at: at, snapshot: snap })] });
  s.runs.push({ post_id: "p1", client_id: CA, mode: "tick", outcome: "failed", transient: true });
  const offerOnGoogle = onGoogle("offer", "2026-09-24T14:30:05Z", {
    topicType: "OFFER", callToAction: undefined,
    offer: { termsConditions: "$79 drain clearing", redeemOnlineUrl: "https://a.example.test/drains/" },
    event: { title: "Fall special", schedule: { startDate: { year: 2026, month: 10, day: 1 }, endDate: { year: 2026, month: 10, day: 31 } } },
  });
  const g2 = fakeGoogle({ existing: [offerOnGoogle] });
  await createPostPublisher({ store, fetch: g2.fetch, now: () => NOW }).tick({ mode: "tick" });
  assert.equal(s.runs.at(-1).outcome, "reconciled");
  assert.equal(s.posts.get("p1").external_post_id, `${LOC}/localPosts/offer`);
  const g3 = fakeGoogle({ existing: [{ ...offerOnGoogle, offer: { ...offerOnGoogle.offer, termsConditions: "$99 drain clearing" } }] });
  const s3 = fakeStore({ posts: [post("p1", { publish_status: "failed", publish_attempts: 1, last_attempt_at: at, snapshot: snap })] });
  s3.s.runs.push({ post_id: "p1", client_id: CA, mode: "tick", outcome: "failed", transient: true });
  await createPostPublisher({ store: s3.store, fetch: g3.fetch, now: () => NOW }).tick({ mode: "tick" });
  assert.match(s3.s.runs.at(-1).detail, /offer terms differ/);
});

test("the publisher closes its own tasks once it verifies the fix; one open task per problem throughout", async () => {
  // Google not connected → task; still broken → no second task; fixed → closed.
  const a = setup({ posts: [post("p1")], secrets: { GOOGLE_OPS_REFRESH_TOKEN: null } });
  await a.pub.tick({ mode: "tick" });
  await a.pub.tick({ mode: "tick" });
  assert.equal(a.s.tasks.filter((t) => t.key === "publisher_connect_google").length, 1);
  a.s.secrets.GOOGLE_OPS_REFRESH_TOKEN = "rt";
  const r = await a.pub.tick({ mode: "tick" });
  const connect = a.s.tasks.find((t) => t.key === "publisher_connect_google");
  assert.equal(connect.status, "done");
  assert.match(connect.closed_with, /Google sign-in works again/);
  assert.ok(r.resolved.includes(connect.id));
  assert.equal(a.s.posts.get("p1").publish_status, "published");

  // The connect task also closes with nothing due, from the tick's own check.
  const idle = setup({ posts: [], secrets: { GOOGLE_OPS_REFRESH_TOKEN: null } });
  idle.s.tasks.push({ id: "t-c", client_id: CA, key: "publisher_connect_google", status: "open", owner: "TOM", notes: "" });
  await idle.pub.tick({ mode: "tick" });
  assert.equal(idle.s.tasks[0].status, "open", "still broken: stays open");
  idle.s.secrets.GOOGLE_OPS_REFRESH_TOKEN = "rt";
  await idle.pub.tick({ mode: "tick" });
  assert.equal(idle.s.tasks[0].status, "done");

  // No profile access → task; access granted → closed (checked each tick, even with nothing due).
  const b = setup({ posts: [post("p1", { scheduled_at: "2026-09-25T15:00:00.000Z" })] }, { access: false });
  b.s.posts.get("p1").scheduled_at = "2026-09-24T14:00:00.000Z";
  await b.pub.tick({ mode: "tick" });
  const access = b.s.tasks.find((t) => t.key === "publisher_profile_access");
  assert.equal(access.status, "open");
  b.s.posts.get("p1").publish_status = "not_scheduled"; // nothing due any more
  await b.pub.tick({ mode: "tick" });
  assert.equal(access.status, "open");
  b.g.access = true;
  await b.pub.tick({ mode: "tick" });
  assert.equal(access.status, "done");
  assert.match(access.closed_with, /reachable/);

  // A post Google would refuse: fix task; once repaired, re-approved and published, it closes.
  const c = setup({ posts: [post("p1", { snapshot: { copy: "x".repeat(1600) } })] });
  await c.pub.tick({ mode: "tick" });
  const fix = c.s.tasks.find((t) => t.key === "publisher_fix_post");
  assert.equal(fix.status, "open");
  Object.assign(c.s.posts.get("p1"), { publish_status: "scheduled", approved_snapshot: snapshot() });
  await c.pub.tick({ mode: "tick" });
  assert.equal(c.s.posts.get("p1").publish_status, "published");
  assert.equal(fix.status, "done");
  assert.match(fix.closed_with, /published as/);

  // A final failure: failed task; a person retries, it publishes, the task closes.
  const d = setup({ posts: [post("p1")] }, { created: [{ status: 400, body: { error: { message: "bad" } } }] });
  await d.pub.tick({ mode: "tick" });
  const failedTask = d.s.tasks.find((t) => t.key === "publisher_failed");
  assert.equal(failedTask.status, "open");
  d.s.posts.get("p1").publish_status = "scheduled"; // Retry
  await d.pub.tick({ mode: "tick" });
  assert.equal(d.s.posts.get("p1").publish_status, "published");
  assert.equal(failedTask.status, "done");

  // An ambiguous check: the person deletes the duplicate and retries; the
  // single match is reconciled and the check task closes. The retry's check
  // looks back to the approval, not to its own claim — otherwise the
  // original post would fall outside the window and be sent again.
  const at = "2026-09-24T14:30:00.000Z";
  const e = setup({ posts: [post("p1", { publish_status: "failed", publish_attempts: 1, last_attempt_at: at })] },
    { existing: [onGoogle("a", "2026-09-24T14:30:05Z"), onGoogle("b", "2026-09-24T14:31:00Z")] });
  e.s.runs.push({ post_id: "p1", client_id: CA, mode: "tick", outcome: "failed", transient: true });
  await e.pub.tick({ mode: "tick" });
  const check = e.s.tasks.find((t) => t.key === "publisher_check_post");
  assert.equal(check.status, "open");
  e.g.existing = [onGoogle("a", "2026-09-24T14:30:05Z")];
  e.s.posts.get("p1").publish_status = "scheduled";
  await e.pub.tick({ mode: "tick" });
  assert.equal(e.s.posts.get("p1").external_post_id, `${LOC}/localPosts/a`);
  assert.equal(check.status, "done");
  assert.equal(e.g.createBodies.length, 0);

  // Other posts' tasks are left alone.
  assert.ok(c.s.tasks.every((t) => t.notes.includes("post_id=p1")));
});

test("re-approving the same copy after an unconfirmed attempt does not hide the original post", async () => {
  const { store, s } = fakeStore({ posts: [post("p1")] });
  const g = fakeGoogle({ created: [{ status: 200, body: {} }] });
  let clock = NOW;
  s.clock = () => clock;
  const claim = store.claim; // stamp claims with the moving clock, as the database does
  store.claim = async (id) => { const r = await claim(id); if (r.ok) { s.posts.get(id).last_attempt_at = clock.toISOString(); r.row.last_attempt_at = clock.toISOString(); } return r; };
  const pub = createPostPublisher({ store, fetch: g.fetch, now: () => clock });
  await pub.tick({ mode: "tick" }); // 15:00 uncertain; the post was created on Google at 15:00:01
  g.existing = [onGoogle("orig", "2026-09-24T15:00:01Z"), onGoogle("dup", "2026-09-24T15:00:02Z")];
  clock = new Date(NOW.getTime() + 11 * 60_000);
  await pub.tick({ mode: "tick" }); // ambiguous
  // A person reopens and re-approves the same copy an hour later, then schedules it.
  Object.assign(s.posts.get("p1"), { reviewed_at: "2026-09-24T16:00:00.000Z", publish_status: "scheduled" });
  g.existing = [onGoogle("orig", "2026-09-24T15:00:01Z")];
  clock = new Date("2026-09-24T16:05:00.000Z");
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").external_post_id, `${LOC}/localPosts/orig`, "found, not sent again");
  assert.equal(g.createBodies.length, 1);
});
