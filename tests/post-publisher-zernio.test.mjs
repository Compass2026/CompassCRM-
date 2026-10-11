// Zernio Social Publisher v1: the post publisher's Facebook path, with an
// in-memory store (0045's claim rules modelled: only an approved, scheduled
// post whose approval still holds is claimed) and a fake Zernio that keeps
// posts, honours Idempotency-Key and can be scripted to answer anything.
// The database side (binding guard, history, gate function) is the sandbox's
// zernio_publisher.test.sql.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPostPublisher } from "../supabase/functions/post-publisher/handler.ts";
import {
  buildCreateBody, idempotencyKey, interpretCreate, interpretPost, planSend, sniffImage,
} from "../supabase/functions/post-publisher/facebook.ts";
import { allowedUrl, createZernioPublisher, scrub } from "../supabase/functions/post-publisher/zernio.ts";

const LUCAS = "102d3b20-2795-44ae-bd64-d1e43916291c";
const OTHER = "00000000-0000-4000-8000-0000000000c2";
const FB_ACC = "1ab8af8e-d720-47ed-8818-e0f2fa91a01e";
const OTHER_ACC = "00000000-0000-4000-8000-00000000a002";
const PAGE = "103977857788955";
const ZACC = "6ac6efe9621dc76465184742";
const PUBLISH_KEY_VALUE = "sk_publish_SECRET_value_1234567890";
const READ_KEY_VALUE = "sk_read_SECRET_value_0987654321";
const NOW = new Date("2026-10-14T15:00:00.000Z");
const PK = "5b0c6a3e-1d2f-4a7b-9c8d-0e1f2a3b4c5d";
const COPY = "Before the next storm: a sealed roof edge keeps water out of the decking. We checked this one in Wentzville last week.";

// A real JPEG header so the type is sniffed from the bytes.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const JPEG_HASH = createHash("sha256").update(JPEG).digest("hex");
const IMG_PATH = `${LUCAS}/photos/edge.jpg`;

const snapshot = (o = {}) => ({
  platform: "facebook", social_account_id: FB_ACC, post_type: "standard", copy: COPY, cta_type: null, cta_url: null,
  offer: null, assets: [], claims: [], ...o,
});
function fbPost(id, o = {}) {
  const snap = snapshot(o.snapshot);
  return {
    id, client_id: LUCAS, platform: "facebook", copy: snap.copy, review_status: "approved", publish_status: "scheduled",
    scheduled_at: "2026-10-14T14:00:00.000Z", publish_attempts: 0, last_attempt_at: null, approved_snapshot: snap,
    reviewed_at: "2026-10-14T12:00:00.000Z", external_post_id: null, published_url: null, published_at: null, error: null,
    social_account_id: snap.social_account_id, publish_key: PK, ...o, snapshot: undefined,
  };
}
const binding = (o = {}) => ({
  id: FB_ACC, client_id: LUCAS, platform: "facebook", external_account_id: PAGE, display_name: "LUCAS Construction",
  publish_provider: "zernio", publish_account_id: ZACC, publish_page_id: PAGE, publish_account_name: "LUCAS Construction",
  publish_enabled: true, publish_verified_at: "2026-10-10T12:00:00.000Z", publish_health: { status: "healthy" }, ...o,
});

function fakeStore({ posts = [], accounts = [binding()], settings = { enabled: true, clients: [LUCAS] }, secrets = {}, claimErrors = {}, files = {} } = {}) {
  let clock = 0;
  const s = {
    posts: new Map(posts.map((p) => [p.id, { ...p }])),
    accounts: new Map(accounts.map((a) => [a.id, { ...a }])),
    runs: [], tasks: [], settings, claimErrors, rechecked: [], binds: [],
    files: { [`brand-assets/${IMG_PATH}`]: JPEG, ...files },
    secrets: { SYNC_CRON_SECRET: "cron", ZERNIO_PUBLISH_API_KEY: PUBLISH_KEY_VALUE, ZERNIO_READ_API_KEY: READ_KEY_VALUE, ...secrets },
    now: NOW,
  };
  const list = (f) => [...s.posts.values()].filter(f).map((p) => ({ ...p }));
  const reminderState = () => {
    const latest = new Map();
    for (const r of s.runs) if (r.outcome === "reminder_opened" || r.outcome === "reminder_closed") latest.set(r.post_id, r);
    return [...latest.values()];
  };
  const store = {
    secret: async (n) => s.secrets[n] ?? null,
    teamMemberForJwt: async (jwt) => ({ "team-jwt": "tm-1", "admin-jwt": "tm-admin" })[jwt] ?? null,
    memberIsAdmin: async (id) => id === "tm-admin",
    settings: async () => s.settings,
    post: async (id) => (s.posts.has(id) ? { ...s.posts.get(id) } : null),
    dueGbpPosts: async () => [],
    stuckGbpPosts: async () => [],
    failedGbpPosts: async () => [],
    dueHandPosts: async (nowIso) => list((p) => p.platform !== "google_business" && p.publish_status === "scheduled" && p.review_status === "approved" && p.scheduled_at <= nowIso),
    openReminders: async () => reminderState().filter((r) => r.outcome === "reminder_opened").map(({ post_id, client_id, task_id }) => ({ post_id, client_id, task_id })),
    reminderOpen: async (id) => reminderState().some((r) => r.post_id === id && r.outcome === "reminder_opened"),
    latestRun: async (id) => [...s.runs].reverse().find((r) => r.post_id === id) ?? null,
    firstAttemptRunAt: async () => null,
    client: async () => null,
    setGbpLocation: async () => {},
    claim: async (id) => {
      const p = s.posts.get(id);
      if (s.claimErrors[id]) return { ok: false, error: s.claimErrors[id] };
      if (!p || p.publish_status !== "scheduled") return { ok: false, error: null };
      // 0045: only an approved post starts publishing.
      if (p.review_status !== "approved") return { ok: false, error: "The post is not approved" };
      p.publish_status = "publishing"; p.publish_attempts += 1; p.last_attempt_at = s.now.toISOString(); p.error = null;
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
    insertRun: async (r) => { s.runs.push({ id: ++clock, transient: false, http_status: null, provider_post_id: null, provider_status: null, request_key: null, provider_media_url: null, created_at: s.now.toISOString(), ...r }); },
    openTask: async (t) => {
      const hit = s.tasks.find((x) => x.client_id === t.client_id && x.key === t.key && x.status !== "done" && (!t.post_id || x.notes.includes(`post_id=${t.post_id}`)));
      if (hit) return hit.id;
      const task = { id: `task-${s.tasks.length + 1}`, status: "open", owner: "TOM", ...t };
      s.tasks.push(task);
      return task.id;
    },
    closeTask: async (id, outcome) => { const t = s.tasks.find((x) => x.id === id); if (t) { t.status = "done"; t.closed_with = outcome; } },
    openTasks: async () => [],
    closeOpenTasks: async (f, outcome) => {
      const hit = s.tasks.filter((t) => f.keys.includes(t.key) && t.status !== "done" && (!f.client_id || t.client_id === f.client_id) && (!f.post_id || t.notes.includes(`post_id=${f.post_id}`)));
      for (const t of hit) { t.status = "done"; t.closed_with = outcome; }
      return hit.map((t) => t.id);
    },
    signPhoto: async () => null,
    account: async (id) => (s.accounts.has(id) ? { ...s.accounts.get(id) } : null),
    facebookAccounts: async () => [...s.accounts.values()].filter((a) => a.platform === "facebook"),
    dueFacebookPosts: async (nowIso, limit) => list((p) => p.platform === "facebook" && p.publish_status === "scheduled" && p.review_status === "approved" && p.scheduled_at <= nowIso).slice(0, limit),
    publishingFacebookPosts: async () => list((p) => p.platform === "facebook" && p.publish_status === "publishing"),
    failedFacebookPosts: async () => list((p) => p.platform === "facebook" && p.publish_status === "failed" && p.review_status === "approved"),
    zernioRuns: async (id) => s.runs.filter((r) => r.post_id === id && r.transport === "zernio"),
    postGate: async (id) => { const p = s.posts.get(id); return p ? { review_status: p.review_status, publish_status: p.publish_status, hash_ok: !s.claimErrors[id], grounding_problems: [] } : null; },
    brandAsset: async (id) => (id === "ba-edge" ? { id, client_id: LUCAS, storage_path: IMG_PATH, content_hash: JPEG_HASH, mime_type: "image/jpeg" } : null),
    creativeAsset: async () => null,
    download: async (bucket, path) => { const b = s.files[`${bucket}/${path}`]; return b ? { bytes: b, type: "image/jpeg" } : null; },
    bindAccount: async (v) => {
      s.binds.push(v);
      const a = s.accounts.get(v.social_account_id);
      const same = a.publish_account_id === v.account_id;
      Object.assign(a, { publish_provider: "zernio", publish_account_id: v.account_id, publish_page_id: v.page_id, publish_account_name: v.account_name,
        publish_verified_at: NOW.toISOString(), publish_health: v.health, publish_enabled: same ? a.publish_enabled : false });
      return { social_account_id: a.id, kind: same ? "verified" : "bound", enabled: a.publish_enabled };
    },
  };
  return { store, s };
}

// A fake Zernio. Posts it creates keep the body; the Idempotency-Key returns
// the original post (as Zernio does inside 24 h). `script` answers the next
// creates instead: { status, body } or { throw }.
function fakeZernio({ script = [], accounts = [{ _id: ZACC, platform: "facebook", displayName: "LUCAS Construction", isActive: true }],
  selectedPageId = PAGE, health = { status: "healthy", tokenStatus: { valid: true }, permissions: { posting: [{ scope: "pages_manage_posts", granted: true, required: true }] } },
  platformResult = (n) => ({ status: "published", platformPostId: `${PAGE}_99${n}`, platformPostUrl: `https://www.facebook.com/${PAGE}/posts/99${n}`, publishedAt: NOW.toISOString() }) } = {}) {
  const z = { calls: [], creates: [], uploads: [], posts: new Map(), byKey: new Map(), script: [...script], getOverride: new Map() };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  z.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    const headers = init.headers ?? {};
    z.calls.push({ method, url: u.toString(), headers: { ...headers } });
    if (u.host === "upload.zernio.test") {
      assert.equal(method, "PUT");
      assert.equal(headers.Authorization, undefined, "the upload never carries the key");
      z.uploads.push({ url: u.toString(), type: headers["Content-Type"], bytes: new Uint8Array(await init.body.arrayBuffer()) });
      return new Response(null, { status: 200 });
    }
    assert.equal(u.origin + "/api", "https://zernio.com/api".replace(/\/api$/, "") + "/api");
    assert.equal(headers.Authorization, `Bearer ${PUBLISH_KEY_VALUE}`, "only the publish key is ever sent");
    const path = u.pathname.replace(/^\/api/, "");
    if (method === "GET" && path === "/v1/accounts") return json(200, { accounts, pagination: { pages: 1 } });
    if (method === "GET" && /\/facebook-page$/.test(path)) return json(200, { pages: [{ id: PAGE, name: "LUCAS Construction" }, { id: "999000111", name: "Other Page" }], selectedPageId });
    if (method === "GET" && /\/health$/.test(path)) return json(200, health);
    if (method === "POST" && path === "/v1/media/presign") {
      const b = JSON.parse(init.body);
      return json(200, { uploadUrl: `https://upload.zernio.test/put/${b.filename}?sig=x`, publicUrl: `https://media.zernio.com/temp/${b.filename}`, expiresIn: 3600 });
    }
    if (method === "POST" && path === "/v1/posts") {
      const key = headers["Idempotency-Key"];
      const body = JSON.parse(init.body);
      z.creates.push({ key, body });
      const next = z.script.shift();
      if (next?.throw) throw new Error(`${next.throw} ${PUBLISH_KEY_VALUE}`);
      if (next) return json(next.status, typeof next.body === "function" ? next.body(z) : next.body);
      if (z.byKey.has(key)) return json(200, { post: z.posts.get(z.byKey.get(key)) });
      const id = `zp${String(z.posts.size + 1).padStart(22, "0")}`;
      const post = { _id: id, content: body.content, status: "published", platforms: [{ platform: "facebook", accountId: { _id: ZACC }, ...platformResult(z.posts.size + 1) }] };
      z.posts.set(id, post); z.byKey.set(key, id);
      return json(201, { post });
    }
    if (method === "GET" && path.startsWith("/v1/posts/")) {
      const id = path.split("/").pop();
      if (z.getOverride.has(id)) return json(200, { post: z.getOverride.get(id) });
      return z.posts.has(id) ? json(200, { post: z.posts.get(id) }) : json(404, { error: "Post not found" });
    }
    return json(404, { error: `unexpected ${method} ${path}` });
  };
  return z;
}

const setup = (storeOpts = {}, zOpts = {}) => {
  const { store, s } = fakeStore(storeOpts);
  const z = fakeZernio(zOpts);
  const pub = createPostPublisher({ store, fetch: z.fetch, now: () => s.now });
  return { pub, s, z };
};
const creates = (z) => z.calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/posts"));
const zernioWrites = (z) => z.calls.filter((c) => c.method !== "GET");

// ── The publish gate ─────────────────────────────────────────────────────────
test("an approved, due Facebook text post is published through Zernio with the exact copy, Page and key", async () => {
  const { pub, s, z } = setup({ posts: [fbPost("p1")] });
  await pub.tick({ mode: "tick" });
  const p = s.posts.get("p1");
  assert.equal(p.publish_status, "published");
  assert.equal(p.published_url, `https://www.facebook.com/${PAGE}/posts/991`);
  assert.equal(p.external_post_id, `${PAGE}_991`);
  assert.equal(z.creates.length, 1);
  assert.deepEqual(z.creates[0].body, {
    content: COPY, publishNow: true,
    platforms: [{ platform: "facebook", accountId: ZACC, platformSpecificData: { pageId: PAGE } }],
  }, "text payload: exact copy, exact account, Page pinned, no media");
  assert.equal(z.creates[0].key, `compass-${PK}-g1`);
  assert.equal(z.calls.filter((c) => c.url.includes("presign")).length, 0);
  const runs = s.runs.filter((r) => r.post_id === "p1");
  assert.deepEqual(runs.map((r) => r.outcome), ["uncertain", "published"], "write-ahead run, then the result");
  assert.equal(runs[1].transport, "zernio");
  assert.equal(runs[1].provider_post_id, z.posts.keys().next().value);
  assert.equal(runs[1].target_account_id, ZACC);
  assert.equal(runs[1].request_key, `compass-${PK}-g1`);
  assert.equal(s.tasks.filter((t) => t.key === "post_by_hand").length, 0, "no hand-posting reminder for a Zernio-routed post");
});

test("the live row is never sent: only the approved snapshot's copy", async () => {
  const p = fbPost("p1");
  p.copy = "LIVE TEXT NEVER APPROVED";
  const { pub, z } = setup({ posts: [p] });
  await pub.tick({ mode: "tick" });
  assert.equal(z.creates[0].body.content, COPY);
});

for (const [label, row] of [
  ["draft", { review_status: "draft", publish_status: "not_scheduled" }],
  ["in_review", { review_status: "in_review", publish_status: "not_scheduled" }],
  ["rejected", { review_status: "rejected", publish_status: "not_scheduled" }],
]) {
  test(`a ${label} post is refused and nothing reaches Zernio`, async () => {
    const { pub, s, z } = setup({ posts: [fbPost("p1", row)] });
    await pub.tick({ mode: "tick" });
    const r = await pub.tick({ mode: "now", postId: "p1" });
    assert.equal(s.posts.get("p1").publish_status, row.publish_status);
    assert.equal(zernioWrites(z).length, 0);
    assert.equal(r.results[0].outcome, "skipped");
  });
}

test("an in_review post that is somehow still scheduled is refused by the claim", async () => {
  const { pub, s, z } = setup({ posts: [fbPost("p1", { review_status: "in_review" })] });
  await pub.tick({ mode: "now", postId: "p1" });
  assert.equal(s.runs.at(-1).outcome, "lapsed");
  assert.equal(creates(z).length, 0);
});

for (const [label, error] of [
  ["hash mismatch", "The post changed since it was approved; it goes back to review"],
  ["grounding lapse", "The post cannot be published: Claim \"Owens Corning certified\" is unverified; unlink it or verify it."],
]) {
  test(`${label}: the 0045 claim refuses, the post is rechecked, nothing is sent`, async () => {
    const { pub, s, z } = setup({ posts: [fbPost("p1")], claimErrors: { p1: error } });
    await pub.tick({ mode: "tick" });
    assert.equal(s.runs.at(-1).outcome, "lapsed");
    assert.equal(s.runs.at(-1).detail, error);
    assert.deepEqual(s.rechecked, ["p1"]);
    assert.equal(zernioWrites(z).length, 0);
  });
}

test("a Page bound to another client is refused", async () => {
  const foreign = binding({ id: OTHER_ACC, client_id: OTHER });
  const p = fbPost("p1", { snapshot: { social_account_id: OTHER_ACC } });
  const { pub, s, z } = setup({ posts: [p], accounts: [binding(), foreign] });
  await pub.tick({ mode: "now", postId: "p1" });
  assert.equal(s.posts.get("p1").publish_status, "scheduled");
  assert.match(s.runs.at(-1).detail, /belongs to another client/);
  assert.equal(z.calls.length, 0);
});

test("a Page with no Zernio binding is refused with a connect task; the tick leaves it to a hand reminder", async () => {
  const unbound = binding({ publish_provider: null, publish_account_id: null, publish_page_id: null, publish_enabled: false, publish_verified_at: null });
  const { pub, s, z } = setup({ posts: [fbPost("p1")], accounts: [unbound] });
  await pub.tick({ mode: "tick" });
  assert.equal(s.tasks.filter((t) => t.key === "post_by_hand").length, 1, "not routed: a person posts it");
  await pub.tick({ mode: "now", postId: "p1" });
  assert.match(s.runs.at(-1).detail, /no verified Zernio account binding/);
  assert.equal(s.tasks.filter((t) => t.key === "publisher_connect_zernio").length, 1);
  assert.equal(z.calls.length, 0);
});

test("a binding that is not enabled is refused, and a snapshot naming no Page is unscheduled to fix", async () => {
  const { pub, s, z } = setup({ posts: [fbPost("p1"), fbPost("p2", { snapshot: { social_account_id: null } })], accounts: [binding({ publish_enabled: false })] });
  await pub.tick({ mode: "now", postId: "p1" });
  assert.match(s.runs.at(-1).detail, /switched off/);
  await pub.tick({ mode: "now", postId: "p2" });
  assert.equal(s.posts.get("p2").publish_status, "not_scheduled");
  assert.equal(s.tasks.find((t) => t.key === "publisher_fix_post").title, "Fix a Facebook post before it can publish");
  assert.equal(z.calls.length, 0);
});

test("pilot switch: Lucas off the pilot list, or the publisher off, sends nothing and falls back to the hand reminder", async () => {
  for (const settings of [{ enabled: true, clients: [] }, { enabled: false, clients: [LUCAS] }]) {
    const { pub, s, z } = setup({ posts: [fbPost("p1")], settings });
    await pub.tick({ mode: "tick" });
    await pub.tick({ mode: "now", postId: "p1" });
    assert.equal(s.posts.get("p1").publish_status, "scheduled");
    assert.equal(s.tasks.filter((t) => t.key === "post_by_hand").length, 1);
    assert.equal(z.calls.length, 0);
  }
});

test("unsupported platforms stay manual", async () => {
  const ig = { ...fbPost("p1"), platform: "instagram", approved_snapshot: snapshot({ platform: "instagram" }) };
  const { pub, s, z } = setup({ posts: [ig] });
  await pub.tick({ mode: "tick" });
  assert.equal(s.runs[0].outcome, "reminder_opened");
  assert.equal(s.runs[0].transport, "manual");
  assert.equal(z.calls.length, 0);
});

test("the publish key must exist and differ from the read key", async () => {
  for (const secrets of [{ ZERNIO_PUBLISH_API_KEY: null }, { ZERNIO_PUBLISH_API_KEY: READ_KEY_VALUE }]) {
    const { pub, s, z } = setup({ posts: [fbPost("p1")], secrets });
    await pub.tick({ mode: "tick" });
    assert.equal(s.posts.get("p1").publish_status, "scheduled");
    assert.equal(s.runs.at(-1).outcome, "blocked");
    assert.equal(s.tasks.filter((t) => t.key === "publisher_connect_zernio").length, 1);
    assert.equal(z.calls.length, 0);
  }
});

// ── Media ────────────────────────────────────────────────────────────────────
test("one image: bytes re-hashed, presigned, PUT without the key, sent as the one media item", async () => {
  const p = fbPost("p1", { snapshot: { assets: [{ id: "ba-edge", storage_path: IMG_PATH, url: null, content_hash: JPEG_HASH, sort_order: 1 }] } });
  const { pub, s, z } = setup({ posts: [p] });
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "published");
  assert.equal(z.uploads.length, 1);
  assert.deepEqual([...z.uploads[0].bytes], [...JPEG]);
  assert.equal(z.uploads[0].type, "image/jpeg");
  assert.deepEqual(z.creates[0].body.mediaItems, [{ type: "image", url: `https://media.zernio.com/temp/compass-p1-${JPEG_HASH.slice(0, 16)}.jpg` }]);
  assert.equal(s.runs.find((r) => r.outcome === "uncertain").provider_media_url, z.creates[0].body.mediaItems[0].url);
});

test("an image whose stored bytes differ from the approved hash is never uploaded", async () => {
  const p = fbPost("p1", { snapshot: { assets: [{ id: "ba-edge", storage_path: IMG_PATH, url: null, content_hash: "0".repeat(64), sort_order: 1 }] } });
  const { pub, s, z } = setup({ posts: [p] });
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "not_scheduled");
  assert.match(s.runs.at(-1).detail, /not the one approved/);
  assert.equal(z.calls.filter((c) => c.method !== "GET").length, 0);
});

test("two images, or an image without a recorded hash, are refused before anything is sent", async () => {
  const two = fbPost("p1", { snapshot: { assets: [
    { id: "a", storage_path: IMG_PATH, url: null, content_hash: JPEG_HASH, sort_order: 1 },
    { id: "b", storage_path: IMG_PATH, url: null, content_hash: JPEG_HASH, sort_order: 2 }] } });
  const unhashed = fbPost("p2", { snapshot: { assets: [{ id: "a", storage_path: IMG_PATH, url: null, content_hash: null, sort_order: 1 }] } });
  const { pub, s, z } = setup({ posts: [two, unhashed] });
  await pub.tick({ mode: "tick" });
  assert.match(s.runs.find((r) => r.post_id === "p1").detail, /one image at most/);
  assert.match(s.runs.find((r) => r.post_id === "p2").detail, /no recorded hash/);
  assert.equal(z.calls.length, 0);
});

// ── Publish now and scheduling ───────────────────────────────────────────────
test("Publish now sends the same payload with publishNow: true", async () => {
  const p = fbPost("p1", { scheduled_at: NOW.toISOString() });
  const { pub, s, z } = setup({ posts: [p] });
  const r = await pub.tick({ mode: "now", postId: "p1" });
  assert.equal(z.creates[0].body.publishNow, true);
  assert.equal(r.results.at(-1).outcome, "published");
  assert.equal(s.runs.at(-1).mode, "now");
});

test("a scheduled post waits for its time (Compass holds the schedule), then goes out; the preflight reads it in America/Chicago", async () => {
  const later = "2026-10-15T14:00:00.000Z"; // 9:00 AM CDT
  const { pub, s, z } = setup({ posts: [fbPost("p1", { scheduled_at: later })] });
  await pub.tick({ mode: "tick" });
  assert.equal(z.creates.length, 0, "not before its time");
  const pre = await (await pub.handle(new Request("http://x", { method: "POST", headers: { "x-cron-secret": "cron" }, body: JSON.stringify({ mode: "preflight", post_id: "p1" }) }))).json();
  assert.equal(pre.timing.kind, "scheduled");
  assert.equal(pre.timing.america_chicago, "Oct 15, 2026, 9:00 AM CDT");
  assert.equal(pre.request.body.publishNow, true);
  s.now = new Date("2026-10-15T14:02:00.000Z");
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "published");
});

// ── Idempotency and reconciliation ───────────────────────────────────────────
test("no answer (timeout): the post stays publishing; the sweep re-sends the SAME key and Zernio returns the one post", async () => {
  const { pub, s, z } = setup({ posts: [fbPost("p1")] }, { script: [{ throw: "The operation was aborted due to timeout" }] });
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "publishing");
  assert.equal(s.runs.at(-1).outcome, "uncertain");
  // Zernio had in fact created it before the connection dropped:
  const post = { _id: "zpdropped00000000000001", content: COPY, platforms: [{ platform: "facebook", accountId: ZACC, status: "published", platformPostId: `${PAGE}_7`, platformPostUrl: `https://www.facebook.com/${PAGE}/posts/7` }] };
  z.posts.set(post._id, post); z.byKey.set(`compass-${PK}-g1`, post._id);
  s.now = new Date(NOW.getTime() + 5 * 60_000);
  await pub.tick({ mode: "tick" });
  assert.equal(z.creates.length, 1, "not before the stuck window");
  s.now = new Date(NOW.getTime() + 11 * 60_000);
  await pub.tick({ mode: "tick" });
  assert.equal(z.creates.length, 2);
  assert.equal(z.creates[1].key, z.creates[0].key, "same Idempotency-Key");
  assert.deepEqual(z.creates[1].body, z.creates[0].body, "identical body");
  assert.equal(z.posts.size, 1, "one post on Facebook");
  assert.equal(s.posts.get("p1").published_url, `https://www.facebook.com/${PAGE}/posts/7`);
});

test("a timeout past Zernio's idempotency window goes to a person, never re-sent", async () => {
  const { pub, s, z } = setup({ posts: [fbPost("p1")] }, { script: [{ throw: "timeout" }] });
  await pub.tick({ mode: "tick" });
  s.now = new Date(NOW.getTime() + 24 * 3_600_000);
  await pub.tick({ mode: "tick" });
  assert.equal(z.creates.length, 1);
  assert.equal(s.posts.get("p1").publish_status, "failed");
  assert.equal(s.runs.at(-1).outcome, "ambiguous");
  assert.equal(s.tasks.find((t) => t.key === "publisher_check_post").title, "Check the Facebook Page before this post is sent again");
});

test("a 409 duplicate pointing at this exact post is reconciled without posting again", async () => {
  const existing = { _id: "zpexisting0000000000001", content: COPY, platforms: [{ platform: "facebook", accountId: { _id: ZACC }, status: "published", platformPostId: `${PAGE}_5`, platformPostUrl: `https://www.facebook.com/${PAGE}/posts/5` }] };
  const { pub, s, z } = setup({ posts: [fbPost("p1")] }, {
    script: [{ status: 409, body: { error: "This exact content is already scheduled, publishing, or was posted to this account within the last 24 hours.", details: { existingPostId: existing._id } } }],
  });
  z.posts.set(existing._id, existing);
  await pub.tick({ mode: "tick" });
  const p = s.posts.get("p1");
  assert.equal(p.publish_status, "published");
  assert.equal(p.published_url, `https://www.facebook.com/${PAGE}/posts/5`);
  assert.equal(s.runs.at(-1).outcome, "reconciled");
  assert.equal(z.creates.length, 1);
});

test("a 409 duplicate pointing at different content goes to a person and is not re-sent", async () => {
  const other = { _id: "zpother000000000000001", content: "Something else", platforms: [{ platform: "facebook", accountId: ZACC, status: "published" }] };
  const { pub, s, z } = setup({ posts: [fbPost("p1")] }, { script: [{ status: 409, body: { error: "duplicate", details: { existingPostId: other._id } } }] });
  z.posts.set(other._id, other);
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "failed");
  assert.equal(s.runs.at(-1).outcome, "ambiguous");
  s.now = new Date(NOW.getTime() + 3 * 3_600_000);
  await pub.tick({ mode: "tick" });
  assert.equal(z.creates.length, 1, "an ambiguous result is never retried automatically");
});

test("409 idempotency_conflict (still processing) is not a failure and not a re-post", async () => {
  const { pub, s, z } = setup({ posts: [fbPost("p1")] }, { script: [{ status: 409, body: { error: "A request with this key is still processing", code: "idempotency_conflict" } }] });
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "publishing");
  assert.equal(s.runs.at(-1).outcome, "uncertain");
  assert.equal(z.creates.length, 1);
});

test("207 with Facebook failed is a failure, not a success; a transient category is retried as a NEW Zernio post", async () => {
  const failed = (zz) => {
    const post = { _id: "zpfailed00000000000001", content: COPY, status: "failed", platforms: [{ platform: "facebook", accountId: ZACC, status: "failed", errorMessage: "Facebook is rate limiting this Page", errorCategory: "platform_rate_limit" }] };
    zz.posts.set(post._id, post);
    return { post };
  };
  const { pub, s, z } = setup({ posts: [fbPost("p1")] }, { script: [{ status: 207, body: failed }] });
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "failed");
  const run = s.runs.at(-1);
  assert.equal(run.outcome, "failed");
  assert.equal(run.transient, true);
  assert.equal(run.provider_post_id, "zpfailed00000000000001");
  // Backoff passes: rescheduled, read back (still failed in Zernio), sent as generation 2.
  s.now = new Date(NOW.getTime() + 11 * 60_000);
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "published");
  assert.equal(z.creates[1].key, `compass-${PK}-g2`);
});

test("207 with Facebook still pending is recorded submitted, then reconciled to the live URL", async () => {
  const pending = (zz) => {
    const post = { _id: "zppending0000000000001", content: COPY, status: "publishing", platforms: [{ platform: "facebook", accountId: ZACC, status: "processing" }] };
    zz.posts.set(post._id, post);
    return { post };
  };
  const { pub, s, z } = setup({ posts: [fbPost("p1")] }, { script: [{ status: 207, body: pending }] });
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "publishing");
  assert.equal(s.runs.at(-1).outcome, "submitted");
  z.getOverride.set("zppending0000000000001", { _id: "zppending0000000000001", content: COPY, status: "published",
    platforms: [{ platform: "facebook", accountId: ZACC, status: "published", platformPostId: `${PAGE}_42`, platformPostUrl: `https://www.facebook.com/${PAGE}/posts/42`, publishedAt: "2026-10-14T15:01:00.000Z" }] });
  s.now = new Date(NOW.getTime() + 60_000);
  await pub.tick({ mode: "tick" });
  const p = s.posts.get("p1");
  assert.equal(p.publish_status, "published");
  assert.equal(p.published_url, `https://www.facebook.com/${PAGE}/posts/42`);
  assert.equal(p.external_post_id, `${PAGE}_42`);
  assert.equal(p.published_at, "2026-10-14T15:01:00.000Z");
  assert.equal(s.runs.at(-1).outcome, "reconciled");
  assert.equal(z.creates.length, 1);
});

test("a disconnected account fails without retry and asks for a reconnect", async () => {
  const { pub, s } = setup({ posts: [fbPost("p1")] }, { script: [{ status: 403, body: { error: "Account disconnected", code: "ACCOUNT_DISCONNECTED" } }] });
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("p1").publish_status, "failed");
  assert.equal(s.runs.at(-1).transient, false);
  assert.equal(s.tasks.filter((t) => t.key === "publisher_reconnect_zernio").length, 1);
  assert.equal(s.tasks.filter((t) => t.key === "publisher_failed").length, 1);
});

test("a 4xx answer creates nothing, so a later deliberate retry uses a new generation", () => {
  const runs = [
    { outcome: "uncertain", created_at: NOW.toISOString(), http_status: null, provider_post_id: null, request_key: `compass-${PK}-g1`, provider_media_url: null },
    { outcome: "failed", created_at: NOW.toISOString(), http_status: 429, provider_post_id: null, request_key: `compass-${PK}-g1`, provider_media_url: null },
  ];
  assert.deepEqual(planSend(runs, PK, NOW), { kind: "send", generation: 2, mediaUrl: null, sameKey: false });
  assert.deepEqual(planSend(runs.slice(0, 1), PK, NOW), { kind: "send", generation: 1, mediaUrl: null, sameKey: true });
  assert.deepEqual(planSend([], PK, NOW), { kind: "send", generation: 1, mediaUrl: null, sameKey: false });
  // A different approval's runs do not count.
  assert.deepEqual(planSend(runs, "another-publish-key", NOW).generation, 1);
});

test("the idempotency key is stable for one approval and generation", () => {
  assert.equal(idempotencyKey(PK, 1), idempotencyKey(PK, 1));
  assert.notEqual(idempotencyKey(PK, 1), idempotencyKey(PK, 2));
  assert.equal(idempotencyKey(PK, 1), `compass-${PK}-g1`);
});

test("interpretCreate / interpretPost read the platform result, not the HTTP status", () => {
  const post = (status, extra = {}) => ({ _id: "zp1", platforms: [{ platform: "facebook", accountId: ZACC, status, ...extra }] });
  const a = (status, json, code = null) => ({ ok: status < 300, status, json, code, message: "m", retryAfterS: null });
  assert.equal(interpretCreate(a(207, { post: post("failed", { errorCategory: "user_content" }) }), ZACC).state.state, "failed");
  assert.equal(interpretCreate(a(201, { post: post("published") }), ZACC).state.state, "pending", "published without a URL is not yet published");
  assert.equal(interpretCreate(a(201, { post: post("published", { platformPostUrl: "https://www.facebook.com/x" }) }), ZACC).state.state, "published");
  assert.equal(interpretCreate(a(201, { post: post("published", { platformPostUrl: "https://www.facebook.com/x" }) }), "000000000000000000000000").state.state, "missing", "another account's result is not ours");
  assert.equal(interpretCreate(a(401, {}), ZACC).kind, "unauthorized");
  assert.equal(interpretCreate(a(403, {}, "ACCOUNT_NOT_ENABLED_FOR_POSTING"), ZACC).kind, "disconnected");
  assert.equal(interpretCreate(a(0, null), ZACC).kind, "transient");
  assert.equal(interpretCreate(a(400, {}), ZACC).kind, "rejected");
  assert.equal(interpretPost(post("failed", { errorCategory: "auth_expired" }), ZACC).needs, "reconnect");
});

// ── Google unchanged ─────────────────────────────────────────────────────────
test("a Business Profile post in the same tick never touches Zernio", async () => {
  const gbp = { ...fbPost("g1"), platform: "google_business", approved_snapshot: { platform: "google_business", post_type: "standard", copy: "x", cta_type: null, cta_url: null, assets: [] } };
  const { store, s } = fakeStore({ posts: [gbp, fbPost("p1")], secrets: { GSC_CLIENT_ID: "cid", GSC_CLIENT_SECRET: "cs", GOOGLE_OPS_REFRESH_TOKEN: "rt" } });
  store.dueGbpPosts = async () => [{ ...s.posts.get("g1") }];
  const z = fakeZernio();
  const seen = [];
  const pub = createPostPublisher({ store, fetch: async (url, init) => { seen.push(String(url)); return z.fetch(url, init); }, now: () => NOW, googleTimeoutMs: 100 });
  await pub.tick({ mode: "tick" });
  assert.ok(seen.some((u) => u.startsWith("https://oauth2.googleapis.com")), "the Google path ran");
  assert.equal(z.creates.length, 1, "only the Facebook post went to Zernio");
  assert.equal(z.creates[0].body.content, COPY);
});

// ── Secrets ──────────────────────────────────────────────────────────────────
test("no key appears in any report, run, task, preflight or error", async () => {
  const { pub, s } = setup({ posts: [fbPost("p1"), fbPost("p2", { social_account_id: FB_ACC })] }, { script: [{ throw: "boom" }, { status: 500, body: { error: `upstream said Bearer ${PUBLISH_KEY_VALUE}` } }] });
  const report = await pub.tick({ mode: "tick" });
  const req = (body) => new Request("http://x", { method: "POST", headers: { "x-cron-secret": "cron" }, body: JSON.stringify(body) });
  const pre = await (await pub.handle(req({ mode: "preflight", post_id: "p1" }))).json();
  const acc = await (await pub.handle(req({ mode: "zernio_accounts" }))).json();
  const all = JSON.stringify({ report, runs: s.runs, tasks: s.tasks, posts: [...s.posts.values()], pre, acc });
  assert.ok(!all.includes(PUBLISH_KEY_VALUE), "publish key leaked");
  assert.ok(!all.includes(READ_KEY_VALUE), "read key leaked");
  assert.match(pre.request.headers.Authorization, /\[ZERNIO_PUBLISH_API_KEY\]/);
  assert.equal(scrub(`Bearer ${PUBLISH_KEY_VALUE} and sk_abc123`), "Bearer [key] and [key]");
});

// ── Allowlist ────────────────────────────────────────────────────────────────
test("the Zernio client refuses anything off its allowlist before fetch, and never creates without a key", async () => {
  let called = 0;
  const z = createZernioPublisher({ apiKey: "sk_x", fetch: async () => { called++; return new Response("{}"); } });
  for (const [m, p] of [["DELETE", "/v1/posts/abc"], ["POST", "/v1/posts/abc/retry"], ["POST", "/v1/posts/abc/unpublish"], ["GET", "/v1/analytics"], ["POST", "/v1/accounts"]]) {
    assert.ok(!(allowedUrl(m, p) instanceof URL), `${m} ${p} must be refused`);
  }
  assert.ok(allowedUrl("GET", "/v1/accounts", { platform: "facebook" }) instanceof URL);
  assert.ok(!(allowedUrl("GET", "/v1/accounts", { profileId: "x" }) instanceof URL), "query names are allowlisted too");
  const r = await z.createPost({}, "");
  assert.equal(r.code, "no_idempotency_key");
  const up = await z.upload("http://insecure.example/put", new Uint8Array([1]), "image/jpeg");
  assert.equal(up.code, "bad_upload_url");
  assert.equal(called, 0);
});

test("payload builder pins the Page and adds media only when given; image type comes from the bytes", () => {
  const b = binding();
  assert.deepEqual(buildCreateBody(snapshot(), b, null).platforms[0].platformSpecificData, { pageId: PAGE });
  assert.equal(buildCreateBody(snapshot(), b, null).mediaItems, undefined);
  assert.equal(buildCreateBody(snapshot(), b, "https://m/x.jpg").mediaItems.length, 1);
  assert.equal(sniffImage(JPEG), "image/jpeg");
  assert.equal(sniffImage(new Uint8Array([0x47, 0x49, 0x46, 0x38])), null, "GIF is not accepted");
});

// ── Verification, binding, preflight (operator / admin) ─────────────────────
const call = (pub, body, headers = { "x-cron-secret": "cron" }) =>
  pub.handle(new Request("http://x", { method: "POST", headers, body: JSON.stringify(body) }));

test("zernio_accounts lists what the publish key sees and matches Pages by exact id only", async () => {
  const { pub, z } = setup({ accounts: [binding({ publish_provider: null, publish_account_id: null, publish_page_id: null, publish_enabled: false, publish_verified_at: null })] });
  const r = await (await call(pub, { mode: "zernio_accounts" })).json();
  assert.equal(r.key.ok, true);
  assert.equal(r.zernio_accounts[0].zernio_account_id, ZACC);
  assert.equal(r.zernio_accounts[0].selected_page_id, PAGE);
  assert.equal(r.zernio_accounts[0].health.postingGranted, true);
  assert.deepEqual(r.compass_accounts[0].exact_matches, [ZACC]);
  assert.equal(zernioWrites(z).length, 0, "read-only");
});

test("zernio_bind re-verifies and binds; it never enables, refuses a Page mismatch and needs an admin", async () => {
  const unbound = binding({ publish_provider: null, publish_account_id: null, publish_page_id: null, publish_enabled: false, publish_verified_at: null });
  const { pub, s } = setup({ accounts: [unbound] });
  assert.equal((await call(pub, { mode: "zernio_bind", social_account_id: FB_ACC, zernio_account_id: ZACC }, { Authorization: "Bearer team-jwt" })).status, 403);
  const ok = await call(pub, { mode: "zernio_bind", social_account_id: FB_ACC, zernio_account_id: ZACC }, { Authorization: "Bearer admin-jwt" });
  assert.equal(ok.status, 200);
  assert.equal(s.accounts.get(FB_ACC).publish_account_id, ZACC);
  assert.equal(s.accounts.get(FB_ACC).publish_enabled, false, "binding never enables publishing");

  const mismatch = setup({ accounts: [unbound] }, { selectedPageId: "999000111" });
  const r = await call(mismatch.pub, { mode: "zernio_bind", social_account_id: FB_ACC, zernio_account_id: ZACC });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /posts to Page 999000111/);
  assert.equal(mismatch.s.binds.length, 0);

  const unhealthy = setup({ accounts: [unbound] }, { health: { status: "error", tokenStatus: { valid: false } } });
  assert.equal((await call(unhealthy.pub, { mode: "zernio_bind", social_account_id: FB_ACC, zernio_account_id: ZACC })).status, 409);
});

test("preflight on a Lucas fixture writes nothing anywhere and shows the exact request", async () => {
  const { pub, s, z } = setup({ settings: { enabled: false, clients: [] }, accounts: [binding({ publish_enabled: false })] });
  const r = await (await call(pub, { mode: "preflight", fixture: { client_id: LUCAS, social_account_id: FB_ACC, copy: COPY, brand_asset_id: "ba-edge" } })).json();
  assert.equal(r.writes, false);
  assert.equal(r.would_publish, false);
  assert.deepEqual(r.blocking.sort(), ["account publishing enabled", "binding gates", "client on the pilot list", "publisher switch on"].sort());
  assert.equal(r.media.actual_sha256, JPEG_HASH);
  assert.equal(r.media.ok, true);
  assert.equal(r.request.body.content, COPY);
  assert.deepEqual(r.request.body.platforms, [{ platform: "facebook", accountId: ZACC, platformSpecificData: { pageId: PAGE } }]);
  assert.equal(r.request.body.mediaItems.length, 1);
  assert.equal(r.timing.kind, "publish_now");
  assert.equal(s.runs.length, 0);
  assert.equal(s.tasks.length, 0);
  assert.equal(zernioWrites(z).length, 0, "no presign, upload or create");
});
