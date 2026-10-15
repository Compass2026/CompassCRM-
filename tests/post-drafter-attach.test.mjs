// post-drafter attach_photo (20261015060000): the handler's side with a fake
// store. The database rules (eligibility, state, staleness, idempotency,
// rollback, history) are proved in supabase/tests/sandbox/drafter_attach_photo.test.sql;
// here: who may call, the client is never the caller's to name, another
// client's photo is never read, the stored bytes are hashed here and that
// hash (not a caller's) goes to the database, the requester is recorded as
// the authenticated caller, and the database's refusals map to statuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPostDrafter, MODES, FEATURES } from "../supabase/functions/post-drafter/handler.ts";
import { attachReply, parseAttach } from "../supabase/functions/post-drafter/attach.ts";

const CLIENT = "102d3b20-2795-44ae-bd64-d1e43916291c";
const OTHER = "00000000-0000-4000-b000-00000000000a";
const POST = "ea0600b3-024d-4784-b761-4a12b8e83a74";
const ASSET = "db6eec44-9c4d-4313-82d7-d27e5dfd9bda";
const MEMBER = "d73e1bf1-4234-491e-8134-b5c3d1fc4977";
const BYTES = new TextEncoder().encode("fictional jpeg bytes");
const HASH = createHash("sha256").update(BYTES).digest("hex");

function setup(over = {}) {
  const calls = { attach: [], bytes: [] };
  const refuse = async () => { throw new Error("attach_photo must not touch this"); };
  const store = {
    secret: async () => "cron",
    teamMemberForJwt: async (jwt) => (jwt === "team-jwt" ? MEMBER : null),
    input: refuse, authority: refuse, attempts: refuse, recordRun: refuse, write: refuse, socialAccounts: refuse,
    attachTarget: async (postId, assetId) => ({
      post: postId === POST ? { id: POST, client_id: CLIENT } : null,
      asset: assetId === ASSET ? { id: ASSET, client_id: CLIENT, storage_path: `${CLIENT}/scan/photo.jpg` }
        : assetId === "11111111-1111-4111-8111-111111111111" ? { id: assetId, client_id: OTHER, storage_path: `${OTHER}/scan/x.jpg` }
        : null,
    }),
    assetBytes: async (path) => { calls.bytes.push(path); return BYTES; },
    attachPhoto: async (p) => {
      calls.attach.push(p);
      return { status: "attached", post_id: p.post_id, client_id: CLIENT, brand_asset_id: p.brand_asset_id, content_hash: p.verified_hash,
               review_status: "in_review", publish_status: "not_scheduled", publish_attempts: 0 };
    },
    ...over,
  };
  const drafter = createPostDrafter({ store });
  const call = async (body, headers = { "x-cron-secret": "cron" }) => {
    const r = await drafter.handle(new Request("http://x", { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  return { call, calls };
}
const body = (extra = {}) => ({
  mode: "attach_photo", post_id: POST, brand_asset_id: ASSET, operation_id: "lucas-ea0600b3-db6eec44",
  expected_updated_at: "2026-10-15T02:46:51.742064+00:00", runtime: "claude-code", ...extra,
});

test("attach_photo is an advertised mode and feature", async () => {
  assert.ok(MODES.includes("attach_photo"));
  assert.ok(FEATURES.includes("attach_photo"));
  const { call } = setup();
  const r = await call({ mode: "version" });
  assert.equal(r.status, 200);
  assert.ok(r.body.modes.includes("attach_photo"));
});

test("no credentials, a bad cron secret or a non-team JWT is refused before anything is read", async () => {
  const { call, calls } = setup();
  assert.equal((await call(body(), {})).status, 401);
  assert.equal((await call(body(), { "x-cron-secret": "wrong" })).status, 403);
  assert.equal((await call(body(), { Authorization: "Bearer stranger" })).status, 403);
  assert.equal(calls.bytes.length + calls.attach.length, 0);
});

test("the worker attaches: the hash of the stored bytes goes to the database, not a caller's", async () => {
  const { call, calls } = setup();
  const r = await call(body({ verified_hash: "f".repeat(64) }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(calls.attach.length, 1);
  assert.deepEqual(calls.attach[0], {
    post_id: POST, brand_asset_id: ASSET, operation_id: "lucas-ea0600b3-db6eec44",
    expected_updated_at: "2026-10-15T02:46:51.742064+00:00", runtime: "claude-code",
    verified_hash: HASH, requested_via: "worker", requested_by: null,
  });
  assert.deepEqual(calls.bytes, [`${CLIENT}/scan/photo.jpg`]);
  assert.ok(!JSON.stringify(r.body).includes("/scan/"), "no storage path or URL in the reply");
});

test("a teammate's request is recorded as that teammate, through the function", async () => {
  const { call, calls } = setup();
  const r = await call(body(), { Authorization: "Bearer team-jwt" });
  assert.equal(r.status, 201);
  assert.equal(calls.attach[0].requested_via, "team");
  assert.equal(calls.attach[0].requested_by, MEMBER);
});

test("the caller never names the client", async () => {
  const { call, calls } = setup();
  const r = await call(body({ client_id: CLIENT }));
  assert.equal(r.status, 400);
  assert.match(r.body.message, /client_id is not accepted/);
  assert.equal(calls.attach.length, 0);
});

test("another client's photo is not found, and its file is never read", async () => {
  const { call, calls } = setup();
  const r = await call(body({ brand_asset_id: "11111111-1111-4111-8111-111111111111" }));
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "asset_not_found");
  assert.equal(calls.bytes.length, 0);
  assert.equal(calls.attach.length, 0);
});

test("an unknown post or photo is not found; an unreadable file is refused", async () => {
  assert.equal((await setup().call(body({ post_id: "22222222-2222-4222-8222-222222222222" }))).status, 404);
  assert.equal((await setup().call(body({ brand_asset_id: "33333333-3333-4333-8333-333333333333" }))).status, 404);
  const { call, calls } = setup({ assetBytes: async () => null });
  const r = await call(body());
  assert.equal(r.status, 422);
  assert.equal(r.body.error, "asset_unstored");
  assert.equal(calls.attach.length, 0);
});

test("request shape: uuids, an operation id, the version read, a runtime label", () => {
  const ok = { post_id: POST, brand_asset_id: ASSET, operation_id: "op-12345678", expected_updated_at: null, runtime: "x" };
  assert.equal(typeof parseAttach(ok), "object");
  assert.match(parseAttach({ ...ok, post_id: "nope" }), /post_id/);
  assert.match(parseAttach({ ...ok, operation_id: "short" }), /operation_id/);
  const missing = { ...ok };
  delete missing.expected_updated_at;
  assert.match(parseAttach(missing), /expected_updated_at is required/);
  assert.match(parseAttach({ ...ok, expected_updated_at: "yesterday-ish" }), /timestamp or null/);
  assert.match(parseAttach({ ...ok, runtime: "" }), /runtime/);
});

test("the database's refusals map to statuses with their code word", () => {
  const map = (code, message) => attachReply({ error: { code, message } });
  assert.deepEqual(map("DR409", "stale_post: the post changed"), { status: 409, body: { error: "stale_post", message: "the post changed" } });
  assert.equal(map("DR409", "post_state: the post is approved").body.error, "post_state");
  assert.equal(map("DR409", "operation_reused: x").body.error, "operation_reused");
  assert.deepEqual(map("DR422", "asset_not_approved: unreviewed").status, 422);
  assert.equal(map("DR422", "asset_hash_mismatch: no").body.error, "asset_hash_mismatch");
  assert.equal(map("P0002", "asset_not_found: no").status, 404);
  assert.equal(map("42501", "drafter_attach_photo runs only in the post-drafter function").status, 403);
  assert.equal(map("23514", "bad_request: runtime").status, 400);
  const g = map("23514", "The post cannot be submitted: Claim \"x\" is unverified; unlink it or verify it.");
  assert.equal(g.status, 422);
  assert.equal(g.body.error, "grounding");
  assert.equal(map("XX000", "boom").status, 500);
  assert.equal(attachReply({ status: "attached", replayed: true }).status, 200, "a replay is not a new attach");
  assert.equal(attachReply({ status: "unchanged" }).status, 200);
});

test("a database refusal reaches the caller as a refusal, with nothing claimed", async () => {
  const { call } = setup({ attachPhoto: async () => ({ error: { code: "DR409", message: "post_state: the post is approved; a person reopens it before its media changes" } }) });
  const r = await call(body());
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "post_state");
  assert.ok(!("review_status" in r.body));
});
