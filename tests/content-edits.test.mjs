// The content-approvals function's delegated post edits (20261020200000) over a
// fake store. The rules themselves (admin, policy, authority, post state,
// review hash, destination, stage, one transaction, replay, attribution) run in
// the database: supabase/tests/sandbox/content_edits.test.sql. Here: request
// validation, that the bytes are measured HERE and never taken from the caller,
// and the honest mapping of outcomes (refused vs unknown).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createContentApprovals, parseHold, parseRelease, parseRevise, parseStage } from "../supabase/functions/content-approvals/handler.ts";

const KEY = "delegation-secret-value";
const CLIENT = "102d3b20-2795-44ae-bd64-d1e43916291c";
const POST = "eba50553-753b-4f91-93a1-b019ca82951d";
const SERVICE = "c82e9fe9-e7c0-4768-ab6e-3dc1ba717b2e";
const STAGE = "5a6e0000-0000-4000-8000-000000000001";
const HASH = "sha256:" + "a".repeat(64);

// A PNG the measurement reads: signature + IHDR (1254 x 1254).
function png(w = 1254, h = 1254, extra = 0) {
  const b = new Uint8Array(33 + extra);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
const BYTES = png();
const SHA = createHash("sha256").update(BYTES).digest("hex");

function fakeStore(o = {}) {
  const calls = [];
  const s = {
    calls,
    async secret(name) { return name === "EXECUTIVE_OS_DELEGATION_SECRET" ? KEY : null; },
    async clientsNamed() { return []; },
    async batch() { return { data: {}, error: null }; },
    async record() { return { data: null, error: null }; },
    async execute() { return { data: null, error: null }; },
    async refuse() { return { data: null, error: null }; },
    async status() { return { data: null, error: null }; },
    async editStage(p) { calls.push(["editStage", p]); if (o.stageThrows) throw new Error("fetch failed");
      return o.stage ?? { data: { id: STAGE, storage_path: `${CLIENT}/upload/${SHA}.png`, expires_at: "2026-10-20T20:30:00Z", replayed: false }, error: null }; },
    async uploadSlot(path) { calls.push(["uploadSlot", path]); return o.slot ?? { exists: false, signed_url: "https://x.supabase.co/storage/v1/object/upload/sign/brand-assets/p?token=t", token: "t" }; },
    async read(path) { calls.push(["read", path]); if (o.readThrows) throw new Error("socket hang up"); return o.read ?? { ok: true, bytes: BYTES }; },
    async editRecord(p) { calls.push(["editRecord", p]); if (o.recordThrows) throw new Error("fetch failed");
      return o.record ?? { data: { id: "rev-1", status: "recorded", storage_path: `${CLIENT}/upload/${SHA}.png` }, error: null }; },
    async editExecute(id, measured) { calls.push(["editExecute", id, measured]); if (o.executeThrows) throw new Error("fetch failed");
      return o.execute ?? { data: { id, status: "executed", result: { review_status: "in_review", publish_status: "not_scheduled" } }, error: null }; },
    async editRefuse(id, code, message) { calls.push(["editRefuse", id, code, message]); return { data: { id, status: "refused", refusal_code: code }, error: null }; },
    async editStatus(op) { calls.push(["editStatus", op]); return o.status ?? { data: null, error: null }; },
    async holdOpen(p) { calls.push(["holdOpen", p]); if (o.holdThrows) throw new Error("fetch failed");
      return o.hold ?? { data: { id: "h1", ref: p.ref, post_id: p.post.id, opened_at: "2026-11-17T10:00:00Z", closed_at: null, replayed: false }, error: null }; },
    async holdClose(ref, reason, note, by) { calls.push(["holdClose", ref, reason, note, by]);
      return o.release ?? { data: { released: true, hold: { id: "h1", ref, post_id: POST, closed_at: "2026-11-17T11:00:00Z", close_reason: reason, superseded_by_ref: by } }, error: null }; },
  };
  return s;
}

const post = (body, key = KEY) => new Request("https://x.supabase.co/functions/v1/content-approvals", {
  method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-compass-delegation-key": key } : {}) }, body: JSON.stringify(body),
});
const call = (store, req) => createContentApprovals({ store }).handle(req);

const stageBody = (o = {}) => ({
  mode: "stage_media", operation_id: "exos-stage-0001", client_id: CLIENT, post: { channel: "facebook", id: POST },
  file: { sha256: SHA, size_bytes: BYTES.length, mime_type: "image/png", width: 1254, height: 1254, file_name: "xmas-04-holiday-logo.png" },
  ...o,
});
const reviseBody = (o = {}) => ({
  mode: "revise", operation_id: "exos-revise-0001", client_id: CLIENT,
  post: { channel: "facebook", id: POST, service_id: SERVICE, review_hash: HASH, destination: "facebook:103977857788955" },
  change: { kind: "replace_media", stage_id: STAGE, sha256: SHA, label: "xmas-04 holiday logo", provenance: "AI-generated illustrative concept; non-evidentiary" },
  executor: { channel: "claude", executed_by: "Claude via Executive OS", account_email: "thomas@compassmarketing.ai" },
  authority: { kind: "standing_policy", id: "pol-1", channels: ["facebook", "google_business"], service_ids: [SERVICE], operations: ["replace_media"] },
  reason: "Tom asked for the holiday logo on every Christmas Lights post.",
  source_ref: { executive_os: { execution_id: "e1", attempt: 1 } },
  ...o,
});

test("version lists the edit modes; only the delegation key opens them", async () => {
  const r = await call(fakeStore(), post({ mode: "version" }));
  const v = await r.json();
  assert.equal(v.version, 5);
  for (const m of ["stage_media", "revise", "revise_status", "hold", "release"]) assert.ok(v.modes.includes(m), m);
  assert.equal((await call(fakeStore(), post(stageBody(), "wrong"))).status, 403);
  assert.equal((await call(fakeStore(), post(reviseBody(), null))).status, 403);
});

test("stage requests are validated before the database is called", () => {
  assert.equal(typeof parseStage(stageBody()), "object");
  const bad = [
    stageBody({ client_id: "lucas" }),
    stageBody({ post: { channel: "blog", id: POST } }),
    stageBody({ post: { channel: "instagram", id: POST } }),
    stageBody({ file: { ...stageBody().file, sha256: "abc" } }),
    stageBody({ file: { ...stageBody().file, mime_type: "image/gif" } }),
    stageBody({ file: { ...stageBody().file, size_bytes: 0 } }),
    stageBody({ file: { ...stageBody().file, width: 0 } }),
    stageBody({ file: { ...stageBody().file, file_name: "../../other/client.png" } }),
  ];
  for (const b of bad) assert.equal(typeof parseStage(b), "string", JSON.stringify(b));
});

test("stage_media records the declared file and hands out a single-use upload slot", async () => {
  const s = fakeStore();
  const r = await call(s, post(stageBody()));
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.stage.id, STAGE);
  assert.match(body.stage.upload_url, /upload\/sign\/brand-assets/);
  assert.equal(body.stage.already_stored, false);
  assert.deepEqual(s.calls.map((c) => c[0]), ["editStage", "uploadSlot"]);
  assert.equal(s.calls[1][1], `${CLIENT}/upload/${SHA}.png`, "the slot is the content-addressed path the database chose");

  // The same bytes are already stored: nothing to upload.
  const again = await (await call(fakeStore({ slot: { exists: true } }), post(stageBody()))).json();
  assert.equal(again.stage.upload_url, null);
  assert.equal(again.stage.already_stored, true);
});

test("stage refusals are definite; an unconfirmed call is unknown", async () => {
  let r = await call(fakeStore({ stage: { data: null, error: { code: "42501", message: "policy_disallows: Delegated edits are switched off in Compass." } } }), post(stageBody()));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "policy_disallows");
  r = await call(fakeStore({ stage: { data: null, error: { code: "CD409", message: "operation_reused: operation exos-stage-0001 was used for a different request" } } }), post(stageBody()));
  assert.equal(r.status, 409);
  r = await call(fakeStore({ stage: { data: null, error: { code: "23514", message: "post_not_found: x is not a post of this client" } } }), post(stageBody()));
  assert.equal(r.status, 422);
  r = await call(fakeStore({ stageThrows: true }), post(stageBody()));
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "outcome_unknown");
});

test("revise requests are validated, and only whitelisted fields reach the database", async () => {
  assert.equal(typeof parseRevise(reviseBody()), "object");
  const bad = [
    reviseBody({ post: { ...reviseBody().post, service_id: undefined } }),
    reviseBody({ post: { ...reviseBody().post, review_hash: "sha256:short" } }),
    reviseBody({ change: { ...reviseBody().change, kind: "approve" } }),
    reviseBody({ change: { ...reviseBody().change, kind: "publish" } }),
    reviseBody({ change: { ...reviseBody().change, label: "" } }),
    reviseBody({ executor: { ...reviseBody().executor, channel: "tom" } }),
    reviseBody({ executor: { ...reviseBody().executor, account_email: "nobody" } }),
    reviseBody({ authority: { ...reviseBody().authority, kind: "task_note" } }),
    reviseBody({ authority: { ...reviseBody().authority, service_ids: [] } }),
    reviseBody({ reason: "" }),
  ];
  for (const b of bad) assert.equal(typeof parseRevise(b), "string", JSON.stringify(b));
  const s = fakeStore();
  await call(s, post(reviseBody({ approved: true, publish_at: "2026-10-21T15:00:00Z", review_status: "approved" })));
  const sent = s.calls.find((c) => c[0] === "editRecord")[1];
  assert.deepEqual(Object.keys(sent).sort(), ["authority", "change", "client_id", "executor", "operation_id", "post", "reason", "source_ref"]);
});

test("revise measures the stored bytes here and executes with the measurement, never the declared hash", async () => {
  const s = fakeStore();
  const r = await call(s, post(reviseBody()));
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.receipt.status, "executed");
  assert.equal(body.receipt.result.review_status, "in_review");
  assert.deepEqual(s.calls.map((c) => c[0]), ["editRecord", "read", "editExecute"]);
  assert.equal(s.calls[1][1], `${CLIENT}/upload/${SHA}.png`);
  const measured = s.calls[2][2];
  assert.equal(measured.content_hash, SHA);
  assert.equal(measured.content_type, "image/png");
  assert.equal(measured.width, 1254);
  assert.equal(measured.height, 1254);
  assert.equal(measured.bytes, BYTES.length);

  // Different bytes in the slot: the measurement carries their real hash (the database refuses the mismatch).
  const other = png(1448, 1086, 5);
  const s2 = fakeStore({ read: { ok: true, bytes: other } });
  await call(s2, post(reviseBody()));
  const m2 = s2.calls.find((c) => c[0] === "editExecute")[2];
  assert.equal(m2.content_hash, createHash("sha256").update(other).digest("hex"));
  assert.equal(m2.width, 1448);
});

test("nothing uploaded, or not an image: refused before the transaction", async () => {
  let s = fakeStore({ read: { ok: false, reason: "missing" } });
  let r = await call(s, post(reviseBody()));
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error, "bytes_missing");
  assert.ok(!s.calls.some((c) => c[0] === "editExecute"));
  assert.equal(s.calls.at(-1)[2], "bytes_missing");

  s = fakeStore({ read: { ok: true, bytes: new TextEncoder().encode("<html>not an image at all</html>") } });
  r = await call(s, post(reviseBody()));
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error, "bytes_mismatch");
  assert.ok(!s.calls.some((c) => c[0] === "editExecute"));
});

test("a refused execution is recorded with its code; an unconfirmed one is unknown and not refused", async () => {
  for (const [msg, code] of [
    ["not_editable: the post is approved / not_scheduled; only an unapproved, unscheduled post in review is revised", "not_editable"],
    ["content_changed: the facebook post x changed since it was read; read the batch again", "content_changed"],
    ["service_mismatch: the post's service is a, not b", "service_mismatch"],
    ["bytes_mismatch: the stored bytes are not the declared file", "bytes_mismatch"],
  ]) {
    const s = fakeStore({ execute: { data: null, error: { code: "23514", message: msg } } });
    const r = await call(s, post(reviseBody()));
    assert.equal(r.status, 422);
    const body = await r.json();
    assert.equal(body.error, code);
    assert.deepEqual(s.calls.at(-1).slice(0, 3), ["editRefuse", "rev-1", code]);
  }
  const s = fakeStore({ executeThrows: true });
  const r = await call(s, post(reviseBody()));
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "outcome_unknown");
  assert.ok(!s.calls.some((c) => c[0] === "editRefuse"), "an unknown outcome is never marked refused");
  const s2 = fakeStore({ readThrows: true });
  assert.equal((await call(s2, post(reviseBody()))).status, 503);
  assert.ok(!s2.calls.some((c) => c[0] === "editRefuse"));
});

test("recording refusals and replays", async () => {
  let r = await call(fakeStore({ record: { data: null, error: { code: "42501", message: "not_authorized: someone@example.test is not a Compass admin who can authorize edits" } } }), post(reviseBody()));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).recorded, false);
  r = await call(fakeStore({ record: { data: null, error: { code: "CD409", message: "operation_reused: operation exos-revise-0001 was used for a different request" } } }), post(reviseBody()));
  assert.equal(r.status, 409);
  r = await call(fakeStore({ recordThrows: true }), post(reviseBody()));
  assert.equal(r.status, 503);

  const s = fakeStore({ record: { data: { id: "rev-1", status: "executed", result: { review_status: "in_review" } }, error: null } });
  r = await call(s, post(reviseBody()));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).replayed, true);
  assert.deepEqual(s.calls.map((c) => c[0]), ["editRecord"], "a replay reads and executes nothing");
});

test("revise_status returns the receipt and the post now, or 404", async () => {
  let r = await call(fakeStore(), post({ mode: "revise_status", operation_id: "exos-revise-0001" }));
  assert.equal(r.status, 404);
  r = await call(fakeStore({ status: { data: { id: "rev-1", status: "executed", post_now: { review_status: "in_review" } }, error: null } }),
    post({ mode: "revise_status", operation_id: "exos-revise-0001" }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).receipt.post_now.review_status, "in_review");
  assert.equal((await call(fakeStore(), post({ mode: "revise_status" }))).status, 400);
});

// ── Pending changes (20261117010000, v5) ────────────────────────────────────
const REF = "0e1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const REF2 = "1e1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const holdBody = (o = {}) => ({
  mode: "hold", ref: REF, client_id: CLIENT, post: { channel: "facebook", id: POST }, kind: "replace_copy", review_hash: HASH,
  summary: "Revise one Facebook post in Compass: replace its copy", requested_by: "Claude via Executive OS", ...o,
});

test("hold and release requests are validated before the database is called", () => {
  assert.equal(typeof parseHold(holdBody()), "object");
  assert.equal(typeof parseHold(holdBody({ kind: "replace_media", review_hash: null })), "object");
  for (const b of [holdBody({ ref: "pol-1" }), holdBody({ kind: "approve" }), holdBody({ post: { channel: "blog", id: POST } }),
                   holdBody({ review_hash: "abc" }), holdBody({ summary: " " }), holdBody({ requested_by: "" })]) {
    assert.equal(typeof parseHold(b), "string", JSON.stringify(b));
  }
  assert.deepEqual(parseRelease({ ref: REF, reason: "superseded", superseded_by_ref: REF2, note: " newer request " }),
    { ref: REF, reason: "superseded", note: "newer request", supersededBy: REF2 });
  for (const b of [{ ref: REF, reason: "executed" }, { ref: REF, reason: "approved" }, { ref: "x", reason: "withdrawn" },
                   { ref: REF, reason: "withdrawn", superseded_by_ref: REF2 }, { ref: REF, reason: "rejected", note: "x".repeat(1001) }]) {
    assert.equal(typeof parseRelease(b), "string", JSON.stringify(b));
  }
});

test("hold opens once per approval; release closes it; outcomes stay honest", async () => {
  const s = fakeStore();
  let r = await call(s, post(holdBody()));
  assert.equal(r.status, 201);
  assert.equal((await r.json()).hold.status, "open");
  assert.deepEqual(s.calls[0], ["holdOpen", { ref: REF, client_id: CLIENT, post: { channel: "facebook", id: POST }, kind: "replace_copy",
    review_hash: HASH, summary: "Revise one Facebook post in Compass: replace its copy", requested_by: "Claude via Executive OS" }]);

  r = await call(fakeStore({ hold: { data: null, error: { code: "23514", message: "not_holdable: the post is approved / scheduled" } } }), post(holdBody()));
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error, "not_holdable");
  r = await call(fakeStore({ holdThrows: true }), post(holdBody()));
  assert.equal(r.status, 503, "a thrown call is unknown, not a refusal");

  const s2 = fakeStore();
  r = await call(s2, post({ mode: "release", ref: REF, reason: "superseded", superseded_by_ref: REF2, note: "Refiled against the new review hash" }));
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.released, true);
  assert.equal(out.hold.close_reason, "superseded");
  assert.deepEqual(s2.calls[0], ["holdClose", REF, "superseded", "Refiled against the new review hash", REF2]);
  // Unknown ref: nothing to release, not an error.
  r = await call(fakeStore({ release: { data: { released: false, hold: null }, error: null } }), post({ mode: "release", ref: REF, reason: "withdrawn" }));
  assert.deepEqual(await r.json(), { released: false, hold: null });
  // Only the delegation key.
  assert.equal((await call(fakeStore(), post(holdBody(), "wrong"))).status, 403);
});

test("an approved stage closes its own hold; a refused one closes it as refused", async () => {
  const s = fakeStore();
  await call(s, post(stageBody({ approval_id: REF })));
  assert.deepEqual(s.calls.map((c) => c[0]), ["editStage", "holdClose", "uploadSlot"]);
  assert.equal(s.calls[1][2], "executed");
  assert.ok(!("approval_id" in s.calls[0][1]), "the stage record never carries the approval id (its request hash is unchanged)");
  const s2 = fakeStore({ stage: { data: null, error: { code: "23514", message: "channel_mismatch: post is a google_business post" } } });
  await call(s2, post(stageBody({ approval_id: REF })));
  assert.deepEqual(s2.calls.map((c) => [c[0], c[2]]), [["editStage", undefined], ["holdClose", "refused"]]);
  // A stage under a standing policy has no approval and touches no hold.
  const s3 = fakeStore();
  await call(s3, post(stageBody()));
  assert.ok(!s3.calls.some((c) => c[0] === "holdClose"));
});
