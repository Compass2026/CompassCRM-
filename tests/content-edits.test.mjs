// The content-approvals function's delegated post edits (20261020200000) over a
// fake store. The rules themselves (admin, policy, authority, post state,
// review hash, destination, stage, one transaction, replay, attribution) run in
// the database: supabase/tests/sandbox/content_edits.test.sql. Here: request
// validation, that the bytes are measured HERE and never taken from the caller,
// and the honest mapping of outcomes (refused vs unknown).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createContentApprovals, parseRevise, parseStage } from "../supabase/functions/content-approvals/handler.ts";

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
    async revisionQueue(limit) { calls.push(["revisionQueue", limit]); return o.queue ?? { data: [], error: null }; },
    async revisionAck(id, gen, receipt) { calls.push(["revisionAck", id, gen, receipt]); if (o.ackThrows) throw new Error("fetch failed");
      return o.ack ?? { data: { id, status: "delivered", generation: gen, receipt, replayed: false }, error: null }; },
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
  assert.equal(v.version, 4);
  for (const m of ["stage_media", "revise", "revise_status", "revision_queue", "revision_ack"]) assert.ok(v.modes.includes(m), m);
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

// ── Rejection corrections (20261026200000): replace_copy, the ChatGPT outbox ──
const OUTBOX = "0b0b0000-0000-4000-8000-000000000001";
const copyBody = (o = {}) => reviseBody({
  change: { kind: "replace_copy", copy: "Siding Installation and Repair in Wentzville.", previous_copy_hash: "b".repeat(64) },
  authority: { ...reviseBody().authority, operations: ["replace_copy"] }, ...o,
});

test("replace_copy: validated, recorded and executed without reading any bytes", async () => {
  assert.equal(typeof parseRevise(copyBody()), "object");
  for (const bad of [
    copyBody({ change: { kind: "replace_copy", copy: "", previous_copy_hash: "b".repeat(64) } }),
    copyBody({ change: { kind: "replace_copy", copy: "x".repeat(3001), previous_copy_hash: "b".repeat(64) } }),
    copyBody({ change: { kind: "replace_copy", copy: "New caption." } }),
    copyBody({ change: { kind: "replace_caption", copy: "New caption.", previous_copy_hash: "b".repeat(64) } }),
  ]) assert.equal(typeof parseRevise(bad), "string");
  const p = parseRevise(copyBody());
  assert.deepEqual(p.change, { kind: "replace_copy", copy: "Siding Installation and Repair in Wentzville.", previous_copy_hash: "b".repeat(64) });
  const s = fakeStore();
  const r = await call(s, post(copyBody()));
  assert.equal(r.status, 201);
  assert.deepEqual(s.calls.map((c) => c[0]), ["editRecord", "editExecute"]);
  assert.deepEqual(s.calls[1][2], {});
});

test("replace_copy: a database refusal is recorded as refused; an unconfirmed execution is unknown", async () => {
  const refused = fakeStore({ execute: { data: null, error: { code: "23514", message: "content_changed: the caption changed since it was read; read it again" } } });
  const r = await call(refused, post(copyBody()));
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error, "content_changed");
  assert.ok(refused.calls.some((c) => c[0] === "editRefuse" && c[2] === "content_changed"));
  const unknown = fakeStore({ executeThrows: true });
  assert.equal((await call(unknown, post(copyBody()))).status, 503);
  assert.ok(!unknown.calls.some((c) => c[0] === "editRefuse"));
});

test("revision_queue: Executive OS reads the queued image work; nothing is written", async () => {
  const item = { outbox_id: OUTBOX, generation: 1, target: "chatgpt", post_id: POST, review_hash: HASH, feedback: "Remove the blue line." };
  const s = fakeStore({ queue: { data: [item], error: null } });
  const r = await call(s, post({ mode: "revision_queue", limit: 5 }));
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).items, [item]);
  assert.deepEqual(s.calls, [["revisionQueue", 5]]);
  assert.equal((await call(fakeStore(), post({ mode: "revision_queue", limit: 500 }))).status, 400);
  assert.equal((await call(fakeStore(), post({ mode: "revision_queue" }, "wrong"))).status, 403);
});

test("revision_ack: one receipt per delivery; refusals and unknown outcomes are kept apart", async () => {
  const body = { mode: "revision_ack", outbox_id: OUTBOX, generation: 1, receipt: { id: "eos-task-1", handoff_id: "h-1" } };
  const ok = fakeStore();
  const r = await call(ok, post(body));
  assert.equal(r.status, 201);
  assert.deepEqual(ok.calls[0], ["revisionAck", OUTBOX, 1, { id: "eos-task-1", handoff_id: "h-1" }]);
  const replay = fakeStore({ ack: { data: { id: OUTBOX, status: "delivered", replayed: true }, error: null } });
  assert.equal((await call(replay, post(body))).status, 200);
  const conflict = fakeStore({ ack: { data: null, error: { code: "CD409", message: "already_delivered: delivered with receipt eos-task-1" } } });
  const c = await call(conflict, post({ ...body, receipt: { id: "eos-task-2" } }));
  assert.equal(c.status, 409);
  assert.equal((await c.json()).error, "already_delivered");
  assert.equal((await call(fakeStore({ ackThrows: true }), post(body))).status, 503);
  for (const bad of [{ ...body, outbox_id: "x" }, { ...body, generation: 0 }, { ...body, receipt: {} }, { ...body, receipt: "eos-task-1" }]) {
    assert.equal((await call(fakeStore(), post(bad))).status, 400);
  }
});
