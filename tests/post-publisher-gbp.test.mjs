// Business Profile through Zernio: the post publisher's googlebusiness path,
// with an in-memory store (0045's claim rules modelled: only an approved,
// scheduled post whose approval still holds is claimed) and a fake Zernio
// that keeps posts, honours Idempotency-Key, echoes platformSpecificData and
// can be scripted to answer anything. The database side (location binding,
// one per client, the pinned location on runs) is the sandbox's
// zernio_gbp.test.sql; Facebook's own suite is post-publisher-zernio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPostPublisher } from "../supabase/functions/post-publisher/handler.ts";
import { buildGbpCreateBody, gbpImageProblem, gbpProblems, gbpRoute, imageSize, locationResource } from "../supabase/functions/post-publisher/gbp.ts";
import { interpretPost, sameContent, targetDrift } from "../supabase/functions/post-publisher/facebook.ts";

const LUCAS = "102d3b20-2795-44ae-bd64-d1e43916291c";
const OTHER = "00000000-0000-4000-8000-0000000000c2";
const GBP_ACC = "00000000-0000-4000-8000-0000000000b1";
const FB_ACC = "1ab8af8e-d720-47ed-8818-e0f2fa91a01e";
const LOC_DIGITS = "4532109876543210987";
const LOC = `locations/${LOC_DIGITS}`;
const ZG = "7bc7efe9621dc76465184743"; // the Zernio googlebusiness account
const ZFB = "6ac6efe9621dc76465184742"; // Lucas's Facebook-only Zernio account
const PUBLISH_KEY_VALUE = "sk_publish_SECRET_value_1234567890";
const READ_KEY_VALUE = "sk_read_SECRET_value_0987654321";
const NOW = new Date("2026-10-14T15:00:00.000Z");
const PK = "6c1d7b4f-2e3a-4b8c-9d0e-1f2a3b4c5d6e";
const COPY = "Quick one for anyone cleaning out gutters this fall.\r\n\r\nUnder the leaves you'll sometimes find a layer of gritty stuff.\r\n\r\nBe careful on the ladder.";

// JPEG headers with a real SOF0 marker, so the type and size come from the bytes.
const jpeg = (w, h) => new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xd9,
]);
const PHOTO = jpeg(480, 360);
const PHOTO_HASH = createHash("sha256").update(PHOTO).digest("hex");
const SMALL = jpeg(320, 240);
const SMALL_HASH = createHash("sha256").update(SMALL).digest("hex");
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const WEBP_HASH = createHash("sha256").update(WEBP).digest("hex");
const IMG_PATH = `${LUCAS}/scan/photo-1789337329451-11.jpg`;
const photo = (o = {}) => ({ id: "8dfb59dd-1aab-4f2f-9200-1aff067b5396", storage_path: IMG_PATH, url: "https://lucasconstructionmo.com/a.jpg", content_hash: PHOTO_HASH, sort_order: 1, ...o });

const snapshot = (o = {}) => ({
  platform: "google_business", social_account_id: GBP_ACC, post_type: "standard", copy: COPY, cta_type: null, cta_url: null,
  offer: null, assets: [], claims: [], ...o,
});
function gbpPost(id, o = {}) {
  const snap = snapshot(o.snapshot);
  return {
    id, client_id: LUCAS, platform: "google_business", copy: snap.copy, review_status: "approved", publish_status: "scheduled",
    scheduled_at: "2026-10-14T14:00:00.000Z", publish_attempts: 0, last_attempt_at: null, approved_snapshot: snap,
    reviewed_at: "2026-10-14T12:00:00.000Z", external_post_id: null, published_url: null, published_at: null, error: null,
    social_account_id: snap.social_account_id, publish_key: PK, ...o, snapshot: undefined,
  };
}
const location = (o = {}) => ({
  id: GBP_ACC, client_id: LUCAS, platform: "google_business", external_account_id: LOC, display_name: "LUCAS Construction - Wentzville",
  publish_provider: "zernio", publish_account_id: ZG, publish_page_id: LOC, publish_account_name: "Lucas Construction",
  publish_enabled: true, publish_verified_at: "2026-10-11T12:00:00.000Z", publish_health: { status: "healthy" }, ...o,
});
const fbBinding = () => ({
  id: FB_ACC, client_id: LUCAS, platform: "facebook", external_account_id: "103977857788955", display_name: "LUCAS Construction",
  publish_provider: "zernio", publish_account_id: ZFB, publish_page_id: "103977857788955", publish_account_name: "LUCAS Construction",
  publish_enabled: true, publish_verified_at: "2026-10-10T12:00:00.000Z", publish_health: { status: "healthy" },
});

function fakeStore({ posts = [], accounts = [location(), fbBinding()], settings = { enabled: true, clients: [LUCAS] }, secrets = {}, claimErrors = {}, files = {}, runs = [], transports = null } = {}) {
  let clock = 0;
  const s = {
    posts: new Map(posts.map((p) => [p.id, { ...p }])),
    accounts: new Map(accounts.map((a) => [a.id, { ...a }])),
    runs: runs.map((r) => ({ id: ++clock, transient: false, http_status: null, provider_post_id: null, provider_status: null, request_key: null, provider_media_url: null, target_account_id: null, target_location_id: null, created_at: NOW.toISOString(), ...r })),
    tasks: [], settings, claimErrors, rechecked: [], binds: [],
    // The client's explicit transport (publisher_client_transports): a bound
    // location means the client chose zernio, as the bind function records.
    transports: new Map(Object.entries(transports ?? (accounts.some((a) => a.platform === "google_business" && a.publish_provider) ? { [LUCAS]: "zernio" } : {}))),
    files: { [`brand-assets/${IMG_PATH}`]: PHOTO, ...files },
    secrets: { SYNC_CRON_SECRET: "cron", ZERNIO_PUBLISH_API_KEY: PUBLISH_KEY_VALUE, ZERNIO_READ_API_KEY: READ_KEY_VALUE, ...secrets },
    now: NOW,
  };
  const list = (f) => [...s.posts.values()].filter(f).map((p) => ({ ...p }));
  const store = {
    secret: async (n) => s.secrets[n] ?? null,
    teamMemberForJwt: async (jwt) => ({ "team-jwt": "tm-1", "admin-jwt": "tm-admin" })[jwt] ?? null,
    memberIsAdmin: async (id) => id === "tm-admin",
    settings: async () => s.settings,
    post: async (id) => (s.posts.has(id) ? { ...s.posts.get(id) } : null),
    dueGbpPosts: async (nowIso, limit) => list((p) => p.platform === "google_business" && p.publish_status === "scheduled" && p.review_status === "approved" && p.scheduled_at <= nowIso).slice(0, limit),
    stuckGbpPosts: async (before) => list((p) => p.platform === "google_business" && p.publish_status === "publishing" && p.last_attempt_at <= before),
    failedGbpPosts: async () => list((p) => p.platform === "google_business" && p.publish_status === "failed" && p.review_status === "approved"),
    publishingGbpPosts: async () => list((p) => p.platform === "google_business" && p.publish_status === "publishing"),
    gbpLocationForClient: async (clientId) => [...s.accounts.values()].find((a) => a.client_id === clientId && a.platform === "google_business" && a.publish_provider) ?? null,
    postRuns: async (id) => s.runs.filter((r) => r.post_id === id),
    gbpTransportForClient: async (clientId) => s.transports.get(clientId) ?? "google",
    dueHandPosts: async () => [],
    openReminders: async () => [],
    reminderOpen: async () => false,
    latestRun: async (id) => [...s.runs].reverse().find((r) => r.post_id === id) ?? null,
    firstAttemptRunAt: async () => null,
    client: async () => null,
    setGbpLocation: async () => {},
    claim: async (id) => {
      const p = s.posts.get(id);
      if (s.claimErrors[id]) return { ok: false, error: s.claimErrors[id] };
      if (!p || p.publish_status !== "scheduled") return { ok: false, error: null };
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
    insertRun: async (r) => {
      if (r.target_location_id) assert.equal(r.transport, "zernio", "only Zernio runs carry a location");
      s.runs.push({ id: ++clock, transient: false, http_status: null, provider_post_id: null, provider_status: null, request_key: null, provider_media_url: null, target_account_id: null, target_location_id: null, created_at: s.now.toISOString(), ...r });
    },
    openTask: async (t) => {
      const hit = s.tasks.find((x) => x.client_id === t.client_id && x.key === t.key && x.status !== "done" && (!t.post_id || x.notes.includes(`post_id=${t.post_id}`)));
      if (hit) return hit.id;
      const task = { id: `task-${s.tasks.length + 1}`, status: "open", owner: "TOM", ...t };
      s.tasks.push(task);
      return task.id;
    },
    closeTask: async (id) => { const t = s.tasks.find((x) => x.id === id); if (t) t.status = "done"; },
    openTasks: async () => [],
    closeOpenTasks: async (f) => {
      const hit = s.tasks.filter((t) => f.keys.includes(t.key) && t.status !== "done" && (!f.client_id || t.client_id === f.client_id) && (!f.post_id || t.notes.includes(`post_id=${f.post_id}`)));
      for (const t of hit) t.status = "done";
      return hit.map((t) => t.id);
    },
    signPhoto: async () => null,
    account: async (id) => (s.accounts.has(id) ? { ...s.accounts.get(id) } : null),
    facebookAccounts: async () => [...s.accounts.values()].filter((a) => a.platform === "facebook"),
    dueFacebookPosts: async () => [],
    publishingFacebookPosts: async () => [],
    failedFacebookPosts: async () => [],
    zernioRuns: async (id) => s.runs.filter((r) => r.post_id === id && r.transport === "zernio"),
    postGate: async (id) => { const p = s.posts.get(id); return p ? { review_status: p.review_status, publish_status: p.publish_status, hash_ok: !s.claimErrors[id], grounding_problems: [] } : null; },
    brandAsset: async () => null,
    creativeAsset: async () => null,
    download: async (bucket, path) => { const b = s.files[`${bucket}/${path}`]; return b ? { bytes: b, type: "image/jpeg" } : null; },
    clientsForGbp: async (piloted) => [{ id: LUCAS, name: "Lucas Construction", website_url: "https://lucasconstructionmo.com", location: await store.gbpLocationForClient(LUCAS) }].filter((c) => piloted.includes(c.id) || c.location),
    bindGbpLocation: async (v) => {
      s.binds.push(v);
      const existing = [...s.accounts.values()].find((a) => a.client_id === v.client_id && a.platform === "google_business" && a.external_account_id === v.location_id);
      const row = existing ?? { id: "new-gbp-row", client_id: v.client_id, platform: "google_business", external_account_id: v.location_id, display_name: v.location_name, publish_enabled: false };
      const same = row.publish_account_id === v.account_id;
      Object.assign(row, { publish_provider: "zernio", publish_account_id: v.account_id, publish_page_id: v.location_id, publish_account_name: v.account_name,
        publish_verified_at: NOW.toISOString(), publish_health: v.health, publish_enabled: same ? row.publish_enabled : false });
      s.accounts.set(row.id, row);
      s.transports.set(v.client_id, "zernio");
      return { social_account_id: row.id, kind: same ? "verified" : "bound", enabled: row.publish_enabled, location_id: v.location_id };
    },
  };
  return { store, s };
}

// A fake Zernio for googlebusiness. Posts it creates echo platformSpecificData
// (as the spec says); the Idempotency-Key returns the original post.
function fakeZernio({ script = [], locations = [{ id: LOC_DIGITS, name: "LUCAS Construction", address: "Wentzville, MO", websiteUrl: "https://lucasconstructionmo.com/", accountId: "accounts/111" }, { id: "999888777", name: "Another Business", websiteUrl: "https://other.example" }],
  selectedLocationId = LOC_DIGITS, accounts = [{ _id: ZG, platform: "googlebusiness", displayName: "Lucas Construction", isActive: true }],
  health = { status: "healthy", tokenStatus: { valid: true }, permissions: { posting: [{ scope: "business.manage", granted: true, required: true }] } },
  platformResult = (n) => ({ status: "published", platformPostId: `1234567890123456${n}`, platformPostUrl: `https://business.google.com/posts/l/${LOC_DIGITS}/p${n}`, publishedAt: NOW.toISOString() }) } = {}) {
  const z = { calls: [], creates: [], uploads: [], posts: new Map(), byKey: new Map(), script: [...script] };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  z.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    const headers = init.headers ?? {};
    z.calls.push({ method, url: u.toString(), headers: { ...headers } });
    if (u.host === "upload.zernio.test") {
      assert.equal(headers.Authorization, undefined, "the upload never carries the key");
      z.uploads.push({ type: headers["Content-Type"], bytes: new Uint8Array(await init.body.arrayBuffer()) });
      return new Response(null, { status: 200 });
    }
    assert.notEqual(u.host, "oauth2.googleapis.com", "never Google's direct API");
    assert.notEqual(u.host, "mybusiness.googleapis.com", "never Google's direct API");
    assert.equal(headers.Authorization, `Bearer ${PUBLISH_KEY_VALUE}`, "only the publish key is ever sent");
    const path = u.pathname.replace(/^\/api/, "");
    if (method === "GET" && path === "/v1/accounts") {
      const platform = u.searchParams.get("platform");
      return json(200, { accounts: accounts.filter((a) => a.platform === platform), pagination: { pages: 1 } });
    }
    if (method === "GET" && /\/gmb-locations$/.test(path)) return json(200, { locations, selectedLocationId, hasMore: false, cached: true });
    if (method === "GET" && /\/health$/.test(path)) return json(200, health);
    if (method === "POST" && path === "/v1/media/presign") {
      const b = JSON.parse(init.body);
      return json(200, { uploadUrl: `https://upload.zernio.test/put/${b.filename}?sig=x`, publicUrl: `https://media.zernio.com/temp/${b.filename}` });
    }
    if (method === "POST" && path === "/v1/posts") {
      const key = headers["Idempotency-Key"];
      const body = JSON.parse(init.body);
      z.creates.push({ key, body });
      const next = z.script.shift();
      if (next?.throw) throw new Error(`${next.throw} ${PUBLISH_KEY_VALUE}`);
      if (next) return json(next.status, typeof next.body === "function" ? next.body(z, body) : next.body);
      if (z.byKey.has(key)) return json(200, { post: z.posts.get(z.byKey.get(key)) });
      const id = `zg${String(z.posts.size + 1).padStart(22, "0")}`;
      const t = body.platforms[0];
      const post = { _id: id, content: body.content, status: "published", platforms: [{ platform: t.platform, accountId: { _id: t.accountId }, platformSpecificData: t.platformSpecificData, ...platformResult(z.posts.size + 1) }] };
      z.posts.set(id, post); z.byKey.set(key, id);
      return json(201, { post });
    }
    if (method === "GET" && path.startsWith("/v1/posts/")) {
      const id = path.split("/").pop();
      return z.posts.has(id) ? json(200, { post: z.posts.get(id) }) : json(404, { error: "Post not found" });
    }
    return json(404, { error: `unexpected ${method} ${path}` });
  };
  return z;
}

const setup = (storeOpts = {}, zOpts = {}) => {
  const { store, s } = fakeStore(storeOpts);
  const z = fakeZernio(zOpts);
  const pub = createPostPublisher({ store, fetch: z.fetch, now: () => s.now, googleTimeoutMs: 100 });
  return { pub, s, z };
};
const call = (pub, body, headers = { "x-cron-secret": "cron" }) => pub.handle(new Request("http://x", { method: "POST", headers, body: JSON.stringify(body) }));
const zernioWrites = (z) => z.calls.filter((c) => c.method !== "GET");
const googleCalls = (z) => z.calls.filter((c) => /googleapis\.com/.test(c.url));

// ── Payload and exact target ─────────────────────────────────────────────────
test("an approved Business Profile post goes to Zernio as googlebusiness, pinned to the exact location, with the exact copy and key", async () => {
  const { pub, s, z } = setup({ posts: [gbpPost("g1")] });
  await pub.tick({ mode: "tick" });
  assert.equal(z.creates.length, 1);
  const c = z.creates[0];
  assert.equal(c.key, `compass-${PK}-g1`);
  assert.deepEqual(c.body, {
    content: COPY,
    platforms: [{ platform: "googlebusiness", accountId: ZG, platformSpecificData: { locationId: LOC, topicType: "STANDARD" } }],
    publishNow: true,
  });
  const p = s.posts.get("g1");
  assert.equal(p.publish_status, "published");
  assert.equal(p.external_post_id, "12345678901234561", "the Google post id");
  assert.equal(p.published_url, `https://business.google.com/posts/l/${LOC_DIGITS}/p1`);
  const runs = s.runs.filter((r) => r.post_id === "g1");
  assert.deepEqual(runs.map((r) => `${r.outcome}:${r.transport}`), ["uncertain:zernio", "published:zernio"]);
  assert.ok(runs.every((r) => r.target_account_id === ZG && r.target_location_id === LOC), "the pinned destination is on every run");
  assert.equal(googleCalls(z).length, 0, "no direct Google call at all");
});

test("one photo: bytes re-hashed, size checked, presigned, PUT without the key, sent as the one media item", async () => {
  const { pub, s, z } = setup({ posts: [gbpPost("g1", { snapshot: { assets: [photo()] } })] });
  await pub.tick({ mode: "tick" });
  assert.equal(z.uploads.length, 1);
  assert.deepEqual(z.uploads[0].bytes, PHOTO);
  assert.equal(z.uploads[0].type, "image/jpeg");
  assert.equal(z.creates[0].body.mediaItems.length, 1);
  assert.match(z.creates[0].body.mediaItems[0].url, /^https:\/\/media\.zernio\.com\/temp\/compass-g1-[0-9a-f]{16}\.jpg$/);
  assert.equal(s.posts.get("g1").publish_status, "published");
});

test("a supported button is carried as Zernio names it; the approved link unchanged", () => {
  const body = buildGbpCreateBody(snapshot({ cta_type: "LEARN_MORE", cta_url: "https://lucasconstructionmo.com/services/roof-replacement" }), location(), null);
  assert.deepEqual(body.platforms[0].platformSpecificData, { locationId: LOC, topicType: "STANDARD", callToAction: { type: "LEARN_MORE", url: "https://lucasconstructionmo.com/services/roof-replacement" } });
  assert.equal(body.mediaItems, undefined);
});

// ── Unsupported fields are refused, never dropped ────────────────────────────
test("offer posts, a Call button, two photos, a link-only photo and over-long copy are refused with a fix task", async () => {
  const cases = {
    offer: { post_type: "offer", offer: { id: "o1", title: "10% off", terms: "Terms", starts_on: null, ends_on: null } },
    call: { cta_type: "CALL" },
    two: { assets: [photo(), photo({ id: "x2", sort_order: 2 })] },
    link: { assets: [photo({ storage_path: null })] },
    long: { copy: "x".repeat(1501) },
  };
  for (const [name, snap] of Object.entries(cases)) {
    const { pub, s, z } = setup({ posts: [gbpPost("g1", { snapshot: snap })] });
    await pub.tick({ mode: "tick" });
    assert.equal(zernioWrites(z).length, 0, `${name}: nothing sent`);
    assert.equal(googleCalls(z).length, 0, `${name}: not sent to Google either`);
    assert.equal(s.posts.get("g1").publish_status, "not_scheduled", `${name}: unscheduled`);
    assert.equal(s.tasks.find((t) => t.key === "publisher_fix_post").title, "Fix a Business Profile post before it can publish");
  }
  assert.match(gbpProblems(snapshot(cases.offer)).map((p) => p.message).join(" "), /Offer and event posts are not published through Zernio/);
  assert.match(gbpProblems(snapshot(cases.call)).map((p) => p.message).join(" "), /Call button cannot be sent/);
});

test("photo limits come from the approved bytes: WebP and anything under 400 × 300 are refused, never converted", () => {
  assert.equal(gbpImageProblem(PHOTO, "image/jpeg"), null);
  assert.deepEqual(imageSize(PHOTO), { width: 480, height: 360 });
  assert.match(gbpImageProblem(SMALL, "image/jpeg"), /320 × 240/);
  assert.match(gbpImageProblem(WEBP, "image/webp"), /not a JPEG or PNG/);
  assert.match(gbpImageProblem(new Uint8Array(5 * 1024 * 1024 + 1), "image/jpeg"), /at most 5 MB/);
});

test("a stored photo that is too small is refused before any upload", async () => {
  const { pub, s, z } = setup({ posts: [gbpPost("g1", { snapshot: { assets: [photo({ storage_path: `${LUCAS}/small.jpg`, content_hash: SMALL_HASH })] } })], files: { [`brand-assets/${LUCAS}/small.jpg`]: SMALL } });
  await pub.tick({ mode: "tick" });
  assert.equal(zernioWrites(z).length, 0);
  assert.match(s.runs.at(-1).detail, /at least 400 × 300/);
});

// ── Approval and media integrity ─────────────────────────────────────────────
test("a photo whose stored bytes differ from the approved hash is never uploaded or sent", async () => {
  const { pub, s, z } = setup({ posts: [gbpPost("g1", { snapshot: { assets: [photo({ content_hash: WEBP_HASH })] } })] });
  await pub.tick({ mode: "tick" });
  assert.equal(zernioWrites(z).length, 0);
  assert.match(s.runs.at(-1).detail, /not the one approved/);
});

test("an approval that no longer holds is refused by the claim, rechecked and sent back; nothing reaches Zernio", async () => {
  const { pub, s, z } = setup({ posts: [gbpPost("g1")], claimErrors: { g1: "The approved content changed since approval" } });
  await pub.tick({ mode: "tick" });
  assert.equal(z.creates.length, 0);
  assert.deepEqual(s.rechecked, ["g1"]);
  assert.equal(s.runs.at(-1).outcome, "lapsed");
});

test("only the approved snapshot is sent, never the live row", async () => {
  const { pub, z } = setup({ posts: [gbpPost("g1", { copy: "A live edit nobody approved." })] });
  await pub.tick({ mode: "tick" });
  assert.equal(z.creates[0].body.content, COPY);
});

// ── Destination and client isolation ─────────────────────────────────────────
test("a location bound to another client is refused", async () => {
  const { pub, s, z } = setup({ posts: [gbpPost("g1")], accounts: [location({ client_id: OTHER })] });
  await pub.tick({ mode: "tick" });
  assert.equal(zernioWrites(z).length, 0);
  assert.match(s.runs.at(-1).detail, /belongs to another client/);
});

test("Lucas's Facebook-only Zernio account is never a Business Profile target", async () => {
  const { pub, s, z } = setup({ posts: [gbpPost("g1", { snapshot: { social_account_id: FB_ACC } })] });
  await pub.tick({ mode: "tick" });
  assert.equal(zernioWrites(z).length, 0);
  assert.match(s.runs.at(-1).detail, /Only Business Profile locations take Business Profile posts/);
  assert.ok(!z.calls.some((c) => c.url.includes(ZFB)));
});

// ── Switches and the route: exactly one publisher, no direct fallback ────────
test("publisher off, client not piloted or location not enabled: nothing is sent anywhere", async () => {
  for (const [name, opts, expect] of [
    ["publisher off", { settings: { enabled: false, clients: [LUCAS] } }, /switched off/],
    ["not piloted", { settings: { enabled: true, clients: [] } }, /pilot list/],
    ["location off", { accounts: [location({ publish_enabled: false })] }, /Publishing to this Business Profile location is switched off/],
    ["unhealthy", { accounts: [location({ publish_health: { status: "error" } })] }, /unhealthy/],
    ["unbound", { accounts: [location({ publish_provider: null, publish_account_id: null, publish_page_id: null, publish_enabled: false })] }, /no verified Zernio binding/],
  ]) {
    const { pub, s, z } = setup({ posts: [gbpPost("g1")], ...opts });
    await pub.tick({ mode: name === "publisher off" ? "now" : "tick", postId: name === "publisher off" ? "g1" : undefined });
    assert.equal(zernioWrites(z).length, 0, `${name}: nothing to Zernio`);
    assert.equal(googleCalls(z).length, 0, `${name}: never falls back to Google`);
    assert.match(s.runs.at(-1).detail, expect, name);
    assert.equal(s.runs.at(-1).transport, "zernio", `${name}: recorded on the Zernio route`);
  }
});

test("a client switched to Zernio never posts directly: a post approved without its location is refused until approved again", async () => {
  const { pub, s, z } = setup({ posts: [gbpPost("g1", { snapshot: { social_account_id: null } })], secrets: { GSC_CLIENT_ID: "cid", GSC_CLIENT_SECRET: "cs", GOOGLE_OPS_REFRESH_TOKEN: "rt" } });
  await pub.tick({ mode: "tick" });
  assert.equal(googleCalls(z).length, 0, "Google is not even asked for a token");
  assert.equal(zernioWrites(z).length, 0);
  assert.match(s.runs.at(-1).detail, /names no Business Profile location/);
  assert.equal(s.posts.get("g1").publish_status, "not_scheduled");
});

test("a client without a Zernio location keeps the direct Google path, unchanged", async () => {
  assert.equal(gbpRoute(null, false), "google");
  assert.equal(gbpRoute(null, true), "zernio");
  assert.equal(gbpRoute(GBP_ACC, false), "zernio");
  const { store, s } = fakeStore({ posts: [gbpPost("g1", { snapshot: { social_account_id: null } })], accounts: [fbBinding()], secrets: { GSC_CLIENT_ID: "cid", GSC_CLIENT_SECRET: "cs", GOOGLE_OPS_REFRESH_TOKEN: "rt" } });
  const seen = [];
  const pub = createPostPublisher({ store, fetch: async (url) => { seen.push(String(url)); return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }); }, now: () => NOW, googleTimeoutMs: 100 });
  await pub.tick({ mode: "tick" });
  assert.ok(seen.some((u) => u.startsWith("https://oauth2.googleapis.com")), "the Google path ran");
  assert.ok(!seen.some((u) => u.includes("zernio.com")), "Zernio was not used");
  assert.equal(s.runs.at(-1).transport, "google");
});

test("a Business Profile post still carrying a Facebook Page id (switched draft) keeps the direct path for a client without a Zernio location", async () => {
  const { store, s } = fakeStore({ posts: [gbpPost("g1", { snapshot: { social_account_id: FB_ACC } })], accounts: [fbBinding()], secrets: { GSC_CLIENT_ID: "cid", GSC_CLIENT_SECRET: "cs", GOOGLE_OPS_REFRESH_TOKEN: "rt" } });
  const seen = [];
  const pub = createPostPublisher({ store, fetch: async (url) => { seen.push(String(url)); return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }); }, now: () => NOW, googleTimeoutMs: 100 });
  await pub.tick({ mode: "tick" });
  assert.ok(seen.some((u) => u.startsWith("https://oauth2.googleapis.com")), "the direct path ran, as before");
  assert.ok(!seen.some((u) => u.includes("zernio.com")));
  assert.equal(s.runs.at(-1).transport, "google");
});

test("an unsettled direct-Google attempt blocks the Zernio send until a person checks the profile", async () => {
  const { pub, s, z } = setup({ posts: [gbpPost("g1")], runs: [{ post_id: "g1", client_id: LUCAS, mode: "tick", outcome: "uncertain", transport: "google" }] });
  await pub.tick({ mode: "tick" });
  assert.equal(zernioWrites(z).length, 0);
  assert.match(s.runs.at(-1).detail, /directly to Google has no settled answer/);
  const pre = await (await call(pub, { mode: "preflight", post_id: "g1" })).json();
  assert.ok(pre.blocking.includes("no unsettled attempt by another transport"));
});

test("the Google path's sweeps leave Zernio posts alone, and Zernio's leave direct ones alone", async () => {
  const { pub, s, z } = setup({ posts: [gbpPost("g1", { publish_status: "publishing", publish_attempts: 1, last_attempt_at: "2026-10-14T14:00:00.000Z" })],
    runs: [{ post_id: "g1", client_id: LUCAS, mode: "tick", outcome: "uncertain", transport: "zernio", request_key: `compass-${PK}-g1`, target_account_id: ZG, target_location_id: LOC, created_at: "2026-10-14T14:00:00.000Z" }],
    secrets: { GSC_CLIENT_ID: "cid", GSC_CLIENT_SECRET: "cs", GOOGLE_OPS_REFRESH_TOKEN: "rt" } });
  await pub.tick({ mode: "tick" });
  assert.equal(googleCalls(z).length, 0, "the stuck Google sweep does not touch it");
  assert.equal(z.creates.length, 1, "the Zernio sweep re-sent the same key");
  assert.equal(z.creates[0].key, `compass-${PK}-g1`);
  assert.equal(s.posts.get("g1").publish_status, "published");
});

test("a post the direct path claimed is still settled through Google (read only) after its client switches to Zernio", async () => {
  const stuck = gbpPost("g1", { publish_status: "publishing", publish_attempts: 1, last_attempt_at: "2026-10-14T14:00:00.000Z", snapshot: { social_account_id: null } });
  const { store, s } = fakeStore({ posts: [stuck], runs: [{ post_id: "g1", client_id: LUCAS, mode: "tick", outcome: "uncertain", transport: "google" }],
    secrets: { GSC_CLIENT_ID: "cid", GSC_CLIENT_SECRET: "cs", GOOGLE_OPS_REFRESH_TOKEN: "rt" } });
  const seen = [];
  const pub = createPostPublisher({ store, now: () => NOW, googleTimeoutMs: 100, fetch: async (url, init = {}) => {
    seen.push(`${init.method ?? "GET"} ${String(url)}`);
    return new Response(JSON.stringify({ access_token: "at" }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  await pub.tick({ mode: "tick" });
  assert.ok(seen.some((u) => u.includes("oauth2.googleapis.com")), "the Google sweep looked at it");
  assert.ok(!seen.some((u) => u.includes("zernio.com")), "nothing went to Zernio");
  assert.ok(!seen.some((u) => u.startsWith("POST") && u.includes("localPosts")), "nothing was posted to Google");
  assert.equal(s.posts.get("g1").publish_status, "publishing");
});

// ── Never a second post ──────────────────────────────────────────────────────
test("no answer (timeout): the post stays publishing; the sweep re-sends the SAME key and body; one post", async () => {
  const { pub, s, z } = setup({ posts: [gbpPost("g1", { snapshot: { assets: [photo()] } })] }, { script: [{ throw: "The operation was aborted due to timeout" }] });
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("g1").publish_status, "publishing");
  s.now = new Date(NOW.getTime() + 11 * 60_000);
  await pub.tick({ mode: "tick" });
  assert.equal(z.creates.length, 2);
  assert.equal(z.creates[1].key, z.creates[0].key, "same key");
  assert.deepEqual(z.creates[1].body, z.creates[0].body, "same body, same uploaded photo");
  assert.equal(z.uploads.length, 1, "the photo is not uploaded again");
  assert.equal(z.posts.size, 1);
  assert.equal(s.posts.get("g1").publish_status, "published");
});

test("a 409 duplicate of this exact post on this location is reconciled; on another location it goes to a person", async () => {
  const mk = (loc) => (z, body) => {
    const id = "zg000000000000000000dupe";
    z.posts.set(id, { _id: id, content: body.content, status: "published", platforms: [{ platform: "googlebusiness", accountId: ZG, platformSpecificData: { locationId: loc }, status: "published", platformPostId: "777", platformPostUrl: "https://business.google.com/posts/777" }] });
    return { error: "duplicate", details: { existingPostId: id } };
  };
  const same = setup({ posts: [gbpPost("g1")] }, { script: [{ status: 409, body: mk(LOC) }] });
  await same.pub.tick({ mode: "tick" });
  assert.equal(same.s.posts.get("g1").publish_status, "published");
  assert.equal(same.s.runs.at(-1).outcome, "reconciled");
  const other = setup({ posts: [gbpPost("g1")] }, { script: [{ status: 409, body: mk("locations/999888777") }] });
  await other.pub.tick({ mode: "tick" });
  assert.equal(other.s.runs.at(-1).outcome, "ambiguous");
  assert.equal(other.s.tasks.find((t) => t.key === "publisher_check_post").title, "Check the Business Profile before this post is sent again");
  assert.equal(other.z.creates.length, 1, "never posted again");
});

test("207: the googlebusiness entry decides — failed is a failure, pending is submitted then reconciled", async () => {
  const failed = setup({ posts: [gbpPost("g1")] }, { script: [{ status: 207, body: { post: { _id: "zg000000000000000000f207", status: "failed", platforms: [{ platform: "googlebusiness", accountId: ZG, platformSpecificData: { locationId: LOC }, status: "failed", errorMessage: "Location not verified", errorCategory: "account_issue" }] } } }] });
  await failed.pub.tick({ mode: "tick" });
  assert.equal(failed.s.posts.get("g1").publish_status, "failed");
  assert.match(failed.s.posts.get("g1").error, /Business Profile \(via Zernio\) failed: Location not verified/);
  assert.ok(failed.s.tasks.some((t) => t.key === "publisher_reconnect_zernio" && t.title === "Reconnect the client's Business Profile in Zernio"));

  const pending = setup({ posts: [gbpPost("g1")] }, { script: [{ status: 207, body: (z, body) => {
    const post = { _id: "zg000000000000000000p207", content: body.content, status: "scheduled", platforms: [{ platform: "googlebusiness", accountId: ZG, platformSpecificData: { locationId: LOC }, status: "pending" }] };
    z.posts.set(post._id, post);
    return { post };
  } }] });
  await pending.pub.tick({ mode: "tick" });
  assert.equal(pending.s.runs.at(-1).outcome, "submitted");
  assert.equal(pending.s.posts.get("g1").publish_status, "publishing");
  Object.assign(pending.z.posts.get("zg000000000000000000p207").platforms[0], { status: "published", platformPostId: "55", platformPostUrl: "https://business.google.com/posts/55" });
  pending.s.now = new Date(NOW.getTime() + 5 * 60_000);
  await pending.pub.tick({ mode: "tick" });
  assert.equal(pending.s.posts.get("g1").publish_status, "published");
  assert.equal(pending.s.posts.get("g1").external_post_id, "55");
  assert.equal(pending.z.creates.length, 1, "read back, never re-sent");
});

test("an entry for another location or platform is never read as ours", () => {
  const post = { _id: "x", content: "c", status: "published", platforms: [
    { platform: "facebook", accountId: ZG, status: "published", platformPostUrl: "https://www.facebook.com/x" },
    { platform: "googlebusiness", accountId: ZG, platformSpecificData: { locationId: "locations/1" }, status: "published", platformPostUrl: "https://business.google.com/x" },
  ] };
  const m = { platform: "googlebusiness", locationId: LOC, label: "Business Profile" };
  assert.equal(interpretPost(post, ZG, m).state, "missing");
  assert.equal(sameContent(post, "c", ZG, m), false);
  assert.equal(sameContent({ ...post, platforms: [{ platform: "googlebusiness", accountId: ZG, status: "published" }] }, "c", ZG, m), false, "a duplicate must echo the location");
});

test("a binding changed while a post was in flight goes to a person, never re-targeted", async () => {
  assert.equal(targetDrift([{ request_key: `compass-${PK}-g1`, target_account_id: ZG, target_location_id: LOC }], PK, { accountId: ZG, locationId: LOC }), null);
  const { pub, s, z } = setup({ posts: [gbpPost("g1", { publish_status: "publishing", publish_attempts: 1, last_attempt_at: "2026-10-14T14:00:00.000Z" })],
    runs: [{ post_id: "g1", client_id: LUCAS, mode: "tick", outcome: "uncertain", transport: "zernio", request_key: `compass-${PK}-g1`, target_account_id: ZG, target_location_id: "locations/111", created_at: "2026-10-14T14:00:00.000Z" }] });
  await pub.tick({ mode: "tick" });
  assert.equal(z.creates.length, 0);
  assert.equal(s.runs.at(-1).outcome, "ambiguous");
  assert.match(s.runs.at(-1).detail, /went to Zernio account .* \(locations\/111\)/);
});

test("Publish now takes the same path; a retry after a transient failure is a NEW generation", async () => {
  const { pub, s, z } = setup({ posts: [gbpPost("g1")] }, { script: [{ status: 503, body: { error: "upstream" } }] });
  await pub.tick({ mode: "now", postId: "g1" });
  assert.equal(s.posts.get("g1").publish_status, "failed");
  assert.equal(s.runs.at(-1).transient, true);
  s.now = new Date(NOW.getTime() + 11 * 60_000);
  await pub.tick({ mode: "tick" }); // retry scheduled
  await pub.tick({ mode: "tick" }); // and sent
  assert.equal(z.creates.length, 2);
  assert.equal(z.creates[1].key, `compass-${PK}-g2`, "a definite failure moves to the next generation");
  assert.equal(s.posts.get("g1").publish_status, "published");
});

// ── Verification, binding and the no-write preflight ─────────────────────────
test("zernio_gbp_accounts lists accounts, their locations and health beside the clients; read only", async () => {
  const { pub, z } = setup({ accounts: [fbBinding()] });
  const r = await (await call(pub, { mode: "zernio_gbp_accounts" })).json();
  assert.equal(r.key.ok, true);
  assert.equal(r.zernio_accounts[0].zernio_account_id, ZG);
  assert.equal(r.zernio_accounts[0].selected_location_id, LOC);
  assert.deepEqual(r.zernio_accounts[0].locations.map((l) => l.location_id), [LOC, "locations/999888777"]);
  assert.equal(r.compass_clients[0].bound, null);
  assert.deepEqual(r.compass_clients[0].website_matches.map((x) => x.location_id), [LOC], "website host evidence only");
  assert.equal(zernioWrites(z).length, 0);
});

test("zernio_gbp_bind: admin only, the exact location must be the account's, never enables", async () => {
  const { pub, s } = setup({ accounts: [fbBinding()] });
  const req = { mode: "zernio_gbp_bind", client_id: LUCAS, zernio_account_id: ZG, location_id: LOC_DIGITS };
  assert.equal((await call(pub, req, { Authorization: "Bearer team-jwt" })).status, 403);
  const ok = await call(pub, req, { Authorization: "Bearer admin-jwt" });
  assert.equal(ok.status, 200);
  assert.deepEqual(s.binds[0], { client_id: LUCAS, account_id: ZG, location_id: LOC, location_name: "LUCAS Construction", account_name: "Lucas Construction", health: s.binds[0].health });
  assert.equal(s.accounts.get("new-gbp-row").publish_enabled, false, "binding never enables publishing");

  const wrong = setup({ accounts: [fbBinding()] });
  const r = await call(wrong.pub, { ...req, location_id: "locations/123" });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /not among the account's locations/);
  assert.equal(wrong.s.binds.length, 0);

  const fbOnly = setup({ accounts: [fbBinding()] });
  assert.equal((await call(fbOnly.pub, { ...req, zernio_account_id: ZFB })).status, 409, "the Facebook-only account is not a Business Profile account");

  const unhealthy = setup({ accounts: [fbBinding()] }, { health: { status: "error", tokenStatus: { valid: false } } });
  assert.equal((await call(unhealthy.pub, req)).status, 409);
});

test("preflight on the approved Lucas Business Profile post writes nothing and shows the exact request", async () => {
  const post = gbpPost("aca2b919-3993-445d-b520-cc529cd3da6f", { publish_status: "not_scheduled", scheduled_at: null, snapshot: { assets: [photo()] } });
  const { pub, s, z } = setup({ posts: [post], accounts: [location({ publish_enabled: false }), fbBinding()] });
  const r = await (await call(pub, { mode: "preflight", post_id: post.id }, { Authorization: "Bearer team-jwt" })).json();
  assert.equal(r.writes, false);
  assert.deepEqual(r.blocking.sort(), ["account publishing enabled", "binding gates"].sort());
  assert.equal(r.target.location_id, LOC);
  assert.equal(r.target.zernio_account_id, ZG);
  assert.deepEqual(r.request.body.platforms, [{ platform: "googlebusiness", accountId: ZG, platformSpecificData: { locationId: LOC, topicType: "STANDARD" } }]);
  assert.equal(r.request.body.content, COPY);
  assert.equal(r.request.body.mediaItems.length, 1);
  assert.equal(r.media.actual_sha256, PHOTO_HASH);
  assert.ok(r.checks.find((c) => c.gate === "the bound location is one the account manages").ok);
  assert.equal(s.runs.length, 0);
  assert.equal(s.tasks.length, 0);
  assert.equal(zernioWrites(z).length, 0, "no presign, upload or create");
});

test("no key appears in any run, task, report or preflight", async () => {
  const { pub, s } = setup({ posts: [gbpPost("g1"), gbpPost("g2")] }, { script: [{ throw: "boom" }, { status: 500, body: { error: `upstream said Bearer ${PUBLISH_KEY_VALUE}` } }] });
  const report = await pub.tick({ mode: "tick" });
  const pre = await (await call(pub, { mode: "preflight", post_id: "g1" })).json();
  const acc = await (await call(pub, { mode: "zernio_gbp_accounts" })).json();
  const all = JSON.stringify({ report, runs: s.runs, tasks: s.tasks, posts: [...s.posts.values()], pre, acc });
  assert.ok(!all.includes(PUBLISH_KEY_VALUE));
  assert.ok(!all.includes(READ_KEY_VALUE));
});

test("location ids: Zernio's bare digits become locations/<id>; anything else is refused", () => {
  assert.equal(locationResource(LOC_DIGITS), LOC);
  assert.equal(locationResource(LOC), LOC);
  assert.equal(locationResource("accounts/1/locations/2"), null);
  assert.equal(locationResource("Lucas Construction"), null);
});

// ── Review fixes (PR #112) ───────────────────────────────────────────────────
test("REVIEW: a location switched off after a timeout suppresses the same-key re-send; switched on again, the same key goes out once", async () => {
  const { pub, s, z } = setup({ posts: [gbpPost("g1", { snapshot: { assets: [photo()] } })] }, { script: [{ throw: "The operation was aborted due to timeout" }] });
  await pub.tick({ mode: "tick" });
  assert.equal(z.creates.length, 1);
  assert.equal(s.posts.get("g1").publish_status, "publishing");
  s.accounts.get(GBP_ACC).publish_enabled = false;
  s.now = new Date(NOW.getTime() + 11 * 60_000);
  await pub.tick({ mode: "tick" });
  assert.equal(z.creates.length, 1, "location off: no second POST");
  assert.equal(s.posts.get("g1").publish_status, "publishing", "still in flight, ledger intact");
  assert.match(s.runs.at(-1).detail, /Not sent again: .*switched off/);
  await pub.tick({ mode: "tick" });
  assert.equal(s.runs.filter((r) => r.outcome === "blocked").length, 1, "the block is recorded once");
  s.accounts.get(GBP_ACC).publish_enabled = true;
  await pub.tick({ mode: "tick" });
  assert.equal(z.creates.length, 2);
  assert.equal(z.creates[1].key, z.creates[0].key, "the same key");
  assert.deepEqual(z.creates[1].body, z.creates[0].body, "the same body and uploaded photo");
  assert.equal(z.posts.size, 1);
  assert.equal(s.posts.get("g1").publish_status, "published");
});

test("REVIEW: every write gate is re-checked before a re-send: unhealthy, unbound, lapsed approval or grounding, publisher off", async () => {
  for (const [name, change, expect] of [
    ["unhealthy", (s) => { s.accounts.get(GBP_ACC).publish_health = { status: "error" }; }, /unhealthy/],
    ["unbound", (s) => { Object.assign(s.accounts.get(GBP_ACC), { publish_provider: null, publish_account_id: null, publish_page_id: null, publish_enabled: false }); }, /no verified Zernio binding/],
    ["approval lapsed", (s) => { s.claimErrors.g1 = "changed"; }, /approval no longer holds/],
    ["other client", (s) => { s.accounts.get(GBP_ACC).client_id = OTHER; }, /another client/],
  ]) {
    const { pub, s, z } = setup({ posts: [gbpPost("g1")] }, { script: [{ throw: "The operation was aborted due to timeout" }] });
    await pub.tick({ mode: "tick" });
    change(s);
    s.now = new Date(NOW.getTime() + 11 * 60_000);
    await pub.tick({ mode: "tick" });
    assert.equal(z.creates.length, 1, `${name}: no second POST`);
    assert.match(s.runs.at(-1).detail, expect, name);
  }
  const off = setup({ posts: [gbpPost("g1")] }, { script: [{ throw: "The operation was aborted due to timeout" }] });
  await off.pub.tick({ mode: "tick" });
  off.s.settings = { enabled: false, clients: [LUCAS] };
  off.s.now = new Date(NOW.getTime() + 11 * 60_000);
  await off.pub.tick({ mode: "tick" });
  assert.equal(off.z.creates.length, 1, "publisher off: the sweep does not run at all");
});

test("REVIEW: with publishing off, a post Zernio already accepted is still read back and recorded (GET only)", async () => {
  const { pub, s, z } = setup({ posts: [gbpPost("g1")] }, { script: [{ status: 207, body: (z, body) => {
    const post = { _id: "zg000000000000000000p207", content: body.content, status: "scheduled", platforms: [{ platform: "googlebusiness", accountId: ZG, platformSpecificData: { locationId: LOC }, status: "pending" }] };
    z.posts.set(post._id, post);
    return { post };
  } }] });
  await pub.tick({ mode: "tick" });
  s.accounts.get(GBP_ACC).publish_enabled = false;
  Object.assign(z.posts.get("zg000000000000000000p207").platforms[0], { status: "published", platformPostId: "77", platformPostUrl: "https://business.google.com/posts/77" });
  s.now = new Date(NOW.getTime() + 5 * 60_000);
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("g1").publish_status, "published");
  assert.equal(z.creates.length, 1);
});

test("REVIEW: removing the binding keeps the client on Zernio; a legacy approval without a location is never sent to Google", async () => {
  const legacy = gbpPost("review2", { snapshot: { social_account_id: null } });
  const { pub, s, z } = setup({ posts: [legacy], secrets: { GSC_CLIENT_ID: "cid", GSC_CLIENT_SECRET: "cs", GOOGLE_OPS_REFRESH_TOKEN: "rt" } });
  // Unbind exactly as publisher_unbind_account does; the transport row stays.
  Object.assign(s.accounts.get(GBP_ACC), { publish_provider: null, publish_account_id: null, publish_page_id: null, publish_verified_at: null, publish_enabled: false });
  assert.equal(s.transports.get(LUCAS), "zernio");
  await pub.tick({ mode: "tick" });
  assert.equal(googleCalls(z).length, 0, "no Google token, list or create");
  assert.equal(zernioWrites(z).length, 0);
  assert.match(s.runs.at(-1).detail, /names no Business Profile location/);
  assert.equal(s.runs.at(-1).transport, "zernio");
  await pub.tick({ mode: "now", postId: "review2" });
  assert.equal(googleCalls(z).length, 0, "Publish now does not reach Google either");
});

test("REVIEW: only an explicit return to google (an admin, after the unbind) restores the direct path", async () => {
  const legacy = gbpPost("review3", { snapshot: { social_account_id: null } });
  const { store, s } = fakeStore({ posts: [legacy], accounts: [fbBinding()], transports: { [LUCAS]: "google" }, secrets: { GSC_CLIENT_ID: "cid", GSC_CLIENT_SECRET: "cs", GOOGLE_OPS_REFRESH_TOKEN: "rt" } });
  const seen = [];
  const pub = createPostPublisher({ store, fetch: async (url) => { seen.push(String(url)); return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }); }, now: () => NOW, googleTimeoutMs: 100 });
  await pub.tick({ mode: "tick" });
  assert.ok(seen.some((u) => u.startsWith("https://oauth2.googleapis.com")));
  assert.equal(s.runs.at(-1).transport, "google");
});

test("REVIEW: an in-flight Zernio post whose binding was removed is still reconciled at the destination its request recorded, never re-sent", async () => {
  const { pub, s, z } = setup({ posts: [gbpPost("g1")] }, { script: [{ status: 207, body: (z, body) => {
    const post = { _id: "zg000000000000000000p208", content: body.content, status: "scheduled", platforms: [{ platform: "googlebusiness", accountId: ZG, platformSpecificData: { locationId: LOC }, status: "pending" }] };
    z.posts.set(post._id, post);
    return { post };
  } }] });
  await pub.tick({ mode: "tick" });
  Object.assign(s.accounts.get(GBP_ACC), { publish_provider: null, publish_account_id: null, publish_page_id: null, publish_verified_at: null, publish_enabled: false });
  Object.assign(z.posts.get("zg000000000000000000p208").platforms[0], { status: "published", platformPostId: "78", platformPostUrl: "https://business.google.com/posts/78" });
  s.now = new Date(NOW.getTime() + 5 * 60_000);
  await pub.tick({ mode: "tick" });
  assert.equal(s.posts.get("g1").publish_status, "published");
  assert.equal(s.runs.at(-1).target_location_id, LOC);
  assert.equal(z.creates.length, 1);
});
