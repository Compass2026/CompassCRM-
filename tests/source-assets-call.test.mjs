// Recording an uploaded brand asset's hash from the app (src/lib/source-assets-call.ts)
// against the real source-assets handler over a fake store: the app asks for
// an inventory of the one asset, then hash bound to what that inventory
// measured. The hash is always the function's measurement of the stored
// bytes, never a value the app supplies; bytes that change in between are
// refused; failures come back as a sentence, never a throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSourceAssets } from "../supabase/functions/source-assets/handler.ts";
import { isHashableMime, recordStoredAssetHash } from "../src/lib/source-assets-call.ts";

const CLIENT = "70211d71-d9f4-46ab-abe2-ef39c41591fb";
const ASSET = "9c533e43-d3fc-4b05-87dd-cf89029f714d";
const OTHER = "00000000-0000-4000-8000-000000000002";
const MEMBER = "11111111-1111-4111-8111-111111111111";
const hex = (b) => createHash("sha256").update(b).digest("hex");
function png(w, h, fill = 0) {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w); dv.setUint32(20, h);
  b[39] = fill;
  return b;
}
const row = (over = {}) => ({
  id: ASSET, client_id: CLIENT, kind: "social_post", source: "upload", label: "Generated header",
  storage_path: `${CLIENT}/1795195997420-0-header.png`, url: null, mime_type: "image/png",
  size_bytes: 40, width: 1920, height: 1080, content_hash: null, creative_use: "unreviewed", ...over,
});

function setup({ rows, files, over = {}, mutateBetween } = {}) {
  const calls = { record: [], read: [], bodies: [] };
  const store = {
    secret: async (n) => (n === "SYNC_CRON_SECRET" ? "cron" : null),
    caller: async (jwt) => (jwt === "team" ? { member: MEMBER } : jwt === "portal" ? { member: null } : "none"),
    client: async (id) => (id === CLIENT ? { id, name: "Logic Solar" } : null),
    assets: async () => rows.map((r) => ({ ...r })),
    read: async (p) => { calls.read.push(p); return files[p] ? { ok: true, bytes: files[p] } : { ok: false, reason: "missing" }; },
    record: async (p) => {
      calls.record.push(p);
      const r = rows.find((x) => x.id === p.asset_id);
      r.content_hash = p.content_hash; r.width = p.width; r.height = p.height;
      return { asset_id: p.asset_id, status: p.expected_hash ? "rehashed" : "hashed", content_hash: p.content_hash };
    },
    ...over,
  };
  const fn = createSourceAssets({ store });
  const call = async (body, jwt = "team") => {
    calls.bodies.push(body);
    if (body.mode === "hash" && mutateBetween) mutateBetween();
    const res = await fn.handle(new Request("http://x/source-assets", {
      method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` }, body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, calls };
}

test("an uploaded graphic: inventory of that one asset, then hash bound to the measured value", async () => {
  const bytes = png(1920, 1080);
  const rows = [row(), row({ id: OTHER, storage_path: `${CLIENT}/other.png` })];
  const { call, calls } = setup({ rows, files: { [rows[0].storage_path]: bytes, [rows[1].storage_path]: png(10, 10) } });
  const out = await recordStoredAssetHash(call, CLIENT, ASSET);
  assert.equal(out.ok, true); assert.equal(out.status, "hashed");
  assert.equal(out.content_hash, hex(bytes));
  assert.match(out.text, /^Hash recorded \(/);
  // Scoped inventory: the other asset's file is never downloaded.
  assert.deepEqual(calls.bodies.map((b) => b.mode), ["inventory", "hash"]);
  assert.deepEqual(calls.bodies[0].asset_ids, [ASSET]);
  assert.ok(!calls.read.includes(rows[1].storage_path));
  assert.deepEqual(calls.bodies[1].expect, { [ASSET]: hex(bytes) });
  assert.equal(calls.record.length, 1);
  assert.equal(calls.record[0].content_hash, hex(bytes));
  assert.equal(calls.record[0].measured_by, "source-assets/3");
});

test("running it again is unchanged and writes nothing", async () => {
  const bytes = png(1920, 1080);
  const rows = [row({ content_hash: hex(bytes) })];
  const { call, calls } = setup({ rows, files: { [rows[0].storage_path]: bytes } });
  const out = await recordStoredAssetHash(call, CLIENT, ASSET);
  assert.deepEqual([out.ok, out.status], [true, "unchanged"]);
  assert.equal(calls.record.length, 0);
  assert.deepEqual(calls.bodies.map((b) => b.mode), ["inventory"]);
});

test("bytes replaced between inventory and hash are refused, never recorded", async () => {
  const path = `${CLIENT}/1795195997420-0-header.png`;
  const files = { [path]: png(1920, 1080, 1) };
  const { call, calls } = setup({ rows: [row()], files, mutateBetween: () => { files[path] = png(1920, 1080, 2); } });
  const out = await recordStoredAssetHash(call, CLIENT, ASSET);
  assert.deepEqual([out.ok, out.status], [false, "refused"]);
  assert.match(out.text, /changed since inventory/);
  assert.equal(calls.record.length, 0);
});

test("a missing object or an unmeasurable file explains itself", async () => {
  let { call } = setup({ rows: [row()], files: {} });
  let out = await recordStoredAssetHash(call, CLIENT, ASSET);
  assert.deepEqual([out.ok, out.status], [false, "refused"]);
  assert.match(out.text, /not in the brand-assets bucket/);

  ({ call } = setup({ rows: [row()], files: { [row().storage_path]: new TextEncoder().encode("%PDF-1.7") } }));
  out = await recordStoredAssetHash(call, CLIENT, ASSET);
  assert.equal(out.ok, false);
  assert.match(out.text, /Not a PNG, JPEG, GIF or WebP/);
});

test("a database refusal is reported with its code", async () => {
  const { call } = setup({
    rows: [row()], files: { [row().storage_path]: png(1920, 1080) },
    over: { record: async () => { throw new Error("size_mismatch: The bytes read are not the stored object's size"); } },
  });
  const out = await recordStoredAssetHash(call, CLIENT, ASSET);
  assert.deepEqual([out.ok, out.status], [false, "refused"]);
  assert.match(out.text, /\(size mismatch\): size_mismatch: The bytes read/);
});

test("an asset of another client is not found; a v2 function that ignores asset_ids still works", async () => {
  const { call } = setup({ rows: [row({ id: OTHER })], files: { [row().storage_path]: png(1, 1) } });
  const out = await recordStoredAssetHash(call, CLIENT, ASSET);
  assert.deepEqual([out.ok, out.status], [false, "refused"]);
  assert.match(out.text, /did not find this asset/);

  // v2 lists every asset; the helper picks its own entry.
  const bytes = png(1920, 1080);
  const v2 = setup({ rows: [row(), row({ id: OTHER, storage_path: `${CLIENT}/o.png` })], files: { [row().storage_path]: bytes, [`${CLIENT}/o.png`]: png(5, 5) } });
  const v2call = (body) => { const { asset_ids, ...rest } = body; void asset_ids; return v2.call(rest); };
  const ok = await recordStoredAssetHash(v2call, CLIENT, ASSET);
  assert.deepEqual([ok.ok, ok.status, ok.content_hash], [true, "hashed", hex(bytes)]);
  assert.equal(v2.calls.record.length, 1);
});

test("transport failures: expired session, not a teammate, no answer, not deployed", async () => {
  const { call } = setup({ rows: [row()], files: {} });
  assert.match((await recordStoredAssetHash((b) => call(b, "nobody"), CLIENT, ASSET)).text, /session expired/);
  assert.match((await recordStoredAssetHash((b) => call(b, "portal"), CLIENT, ASSET)).text, /Only Compass team members/);
  const none = await recordStoredAssetHash(async () => ({ status: null, body: null }), CLIENT, ASSET);
  assert.deepEqual([none.ok, none.status], [false, "failed"]);
  assert.match(none.text, /did not answer/);
  assert.match((await recordStoredAssetHash(async () => ({ status: 404, body: null }), CLIENT, ASSET)).text, /not deployed/);
});

test("scoped inventory validates asset_ids and reports ids it did not find", async () => {
  const { call } = setup({ rows: [row()], files: { [row().storage_path]: png(1920, 1080) } });
  assert.equal((await call({ mode: "inventory", client_id: CLIENT, asset_ids: [] })).status, 400);
  assert.equal((await call({ mode: "inventory", client_id: CLIENT, asset_ids: ["nope"] })).status, 400);
  const r = await call({ mode: "inventory", client_id: CLIENT, asset_ids: [ASSET, OTHER] });
  assert.equal(r.status, 200); assert.equal(r.body.writes, false);
  assert.equal(r.body.assets.length, 1);
  assert.deepEqual(r.body.missing_asset_ids, [OTHER]);
  // Unscoped inventory is unchanged: no missing_asset_ids key.
  assert.equal("missing_asset_ids" in (await call({ mode: "inventory", client_id: CLIENT })).body, false);
});

test("only measurable image types are sent to be hashed", () => {
  for (const m of ["image/png", "image/jpeg", "image/webp", "image/gif", "IMAGE/PNG"]) assert.equal(isHashableMime(m), true);
  for (const m of ["application/pdf", "image/svg+xml", "", null, undefined]) assert.equal(isHashableMime(m), false);
});
