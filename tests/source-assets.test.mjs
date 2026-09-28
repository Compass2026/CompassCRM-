// source-assets (0055): image measurement from bytes, the inventory plan, and
// the request boundary over a fake store — dry runs write nothing, link-only
// and missing files are reported, hashing is idempotent and bound to the
// inventoried hash, new bytes give a new hash, refusals never abort the rest.
// The database side (who may record a hash, review rules) is the sandbox's
// source_asset_hashing.test.sql.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { measure, jpegOrientation, sha256Hex, sniffImageType } from "../supabase/functions/_shared/image-meta.ts";
import { inspect, importSuggestion, summarize } from "../supabase/functions/source-assets/plan.ts";
import { createSourceAssets, MAX_ASSETS } from "../supabase/functions/source-assets/handler.ts";

// ── tiny, valid-header images ────────────────────────────────────────────────
function png(w, h, extra = 0) {
  const b = new Uint8Array(33 + extra);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w); dv.setUint32(20, h);
  return b;
}
function jpeg(w, h, orientation = null, extra = 0) {
  const parts = [[0xff, 0xd8]];
  if (orientation) {
    // APP1 Exif, big-endian TIFF, one IFD entry: 0x0112 SHORT 1 = orientation
    const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const len = payload.length + 2;
    parts.push([0xff, 0xe1, len >> 8, len & 0xff, ...payload]);
  }
  parts.push([0xff, 0xc0, 0, 17, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  parts.push([0xff, 0xda, 0, 2]);
  parts.push(new Array(extra).fill(7));
  return new Uint8Array(parts.flat());
}
const gif = (w, h) => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 0xff, w >> 8, h & 0xff, h >> 8, 0, 0, 0]);
function webpVP8X(w, h) {
  const b = new Uint8Array(32);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  const W = w - 1, H = h - 1;
  b[24] = W & 0xff; b[25] = (W >> 8) & 0xff; b[26] = (W >> 16) & 0xff;
  b[27] = H & 0xff; b[28] = (H >> 8) & 0xff; b[29] = (H >> 16) & 0xff;
  return b;
}
const hex = (b) => createHash("sha256").update(b).digest("hex");

test("measure reads type and size from the bytes of PNG, JPEG, GIF and WebP", () => {
  assert.deepEqual(measure(png(600, 200)), { content_type: "image/png", bytes: 33, raw_width: 600, raw_height: 200, orientation: 1, width: 600, height: 200 });
  const j = measure(jpeg(1066, 1600));
  assert.equal(j.content_type, "image/jpeg"); assert.equal(j.width, 1066); assert.equal(j.height, 1600); assert.equal(j.orientation, 1);
  assert.equal(measure(gif(40, 30)).width, 40);
  assert.deepEqual([measure(webpVP8X(1200, 900)).width, measure(webpVP8X(1200, 900)).height], [1200, 900]);
});

test("EXIF orientation 5–8 swaps the displayed size; raw size is kept", () => {
  assert.equal(jpegOrientation(jpeg(2048, 1536, 6)), 6);
  const m = measure(jpeg(2048, 1536, 6));
  assert.deepEqual([m.raw_width, m.raw_height, m.width, m.height, m.orientation], [2048, 1536, 1536, 2048, 6]);
  assert.equal(measure(jpeg(2048, 1536, 3)).width, 2048);
});

test("unknown or truncated bytes are not guessed", () => {
  assert.equal(measure(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), null);
  assert.equal(measure(new Uint8Array([0x89, 0x50])), null);
  assert.equal(sniffImageType(new Uint8Array(20)), null);
});

test("sha256Hex is the sha256 of exactly the bytes read", async () => {
  const b = jpeg(10, 10, null, 50);
  assert.equal(await sha256Hex(b), hex(b));
  assert.equal(await sha256Hex(new Uint8Array()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

// ── the plan ─────────────────────────────────────────────────────────────────
const CLIENT = "102d3b20-2795-44ae-bd64-d1e43916291c";
const row = (over = {}) => ({
  id: "00000000-0000-4000-8000-000000000001", client_id: CLIENT, kind: "photo", source: "website_scan",
  label: "Photo from the home page", storage_path: `${CLIENT}/scan/photo-1.jpg`, url: "https://example.test/p1.jpg",
  mime_type: "image/jpeg", size_bytes: null, width: 1066, height: 1600, content_hash: null, creative_use: "unreviewed", ...over,
});

test("a stored, unhashed file: record its hash; recorded dimensions that agree are not a change", async () => {
  const b = jpeg(1066, 1600, null, 100);
  const e = await inspect(row({ size_bytes: b.byteLength }), { ok: true, bytes: b });
  assert.equal(e.stored, "present"); assert.equal(e.action, "record");
  assert.equal(e.measured.content_hash, hex(b));
  assert.deepEqual(e.changes, [`content_hash: none → ${hex(b).slice(0, 12)}…`]);
  assert.deepEqual(e.issues, []); assert.equal(e.review_reset, false);
});

test("a logo without dimensions gets them; recording the same bytes again is unchanged", async () => {
  const b = png(600, 200);
  const e = await inspect(row({ kind: "logo_primary", width: null, height: null, mime_type: "image/png" }), { ok: true, bytes: b });
  assert.deepEqual(e.changes.slice(1), ["width: none → 600", "height: none → 200"]);
  const again = await inspect(row({ kind: "logo_primary", width: 600, height: 200, mime_type: "image/png", content_hash: hex(b) }), { ok: true, bytes: b });
  assert.equal(again.action, "unchanged"); assert.deepEqual(again.changes, []);
});

test("changed bytes: a new hash, flagged, and it resets an approved review", async () => {
  const old = jpeg(1066, 1600, null, 1);
  const now = jpeg(1066, 1600, null, 2);
  assert.notEqual(hex(old), hex(now));
  const e = await inspect(row({ content_hash: hex(old), creative_use: "approved" }), { ok: true, bytes: now });
  assert.equal(e.action, "record"); assert.equal(e.review_reset, true);
  assert.ok(e.issues.some((i) => i.code === "hash_changed"));
});

test("disagreements with the record are reported, not hidden", async () => {
  const b = png(800, 600);
  const e = await inspect(row({ width: 950, height: 1200, size_bytes: 12, mime_type: "image/jpeg" }), { ok: true, bytes: b });
  assert.deepEqual(e.issues.map((i) => i.code).sort(), ["dimensions_differ", "size_differs", "type_differs"]);
  const r = await inspect(row(), { ok: true, bytes: jpeg(2048, 1536, 6) });
  assert.ok(r.issues.some((i) => i.code === "rotated"));
});

test("link-only, missing, unreadable and unsupported files are skipped with the reason", async () => {
  const link = await inspect(row({ storage_path: null, source: "link" }), null);
  assert.equal(link.stored, "no_file"); assert.equal(link.action, "skip"); assert.equal(link.issues[0].code, "link_only");
  assert.equal((await inspect(row(), { ok: false, reason: "missing" })).issues[0].code, "object_missing");
  assert.equal((await inspect(row(), { ok: false, reason: "unreadable", detail: "timeout" })).stored, "unreadable");
  const svg = await inspect(row(), { ok: true, bytes: new TextEncoder().encode("<svg/> padding padding") });
  assert.equal(svg.action, "skip"); assert.equal(svg.issues[0].code, "unsupported_type");
});

test("importSuggestion names brand-scan's import for link-only rows only", () => {
  const s = importSuggestion([row(), row({ id: "00000000-0000-4000-8000-000000000002", storage_path: null, url: "https://x.test/a.jpg", source: "link", kind: "photo", label: "A" })]);
  assert.equal(s.function, "brand-scan");
  assert.deepEqual(s.body.import, [{ url: "https://x.test/a.jpg", kind: "photo", label: "A" }]);
  assert.deepEqual(s.body.remove, ["00000000-0000-4000-8000-000000000002"]);
  assert.equal(importSuggestion([row()]), null);
});

// ── the request boundary ─────────────────────────────────────────────────────
const MEMBER = "11111111-1111-4111-8111-111111111111";
function fake(files, rows, over = {}) {
  const calls = { record: [], read: [] };
  const store = {
    secret: async (n) => (n === "SYNC_CRON_SECRET" ? "cron" : null),
    caller: async (jwt) => (jwt === "team" ? { member: MEMBER } : jwt === "portal" ? { member: null } : "none"),
    client: async (id) => (id === CLIENT ? { id, name: "Lucas Construction" } : null),
    assets: async () => rows.map((r) => ({ ...r })),
    read: async (p) => { calls.read.push(p); return files[p] ? { ok: true, bytes: files[p] } : { ok: false, reason: "missing" }; },
    record: async (p) => { calls.record.push(p); return { asset_id: p.asset_id, status: p.expected_hash ? "rehashed" : "hashed", content_hash: p.content_hash }; },
    ...over,
  };
  return { fn: createSourceAssets({ store }), calls };
}
const req = (body, headers = { Authorization: "Bearer team" }) =>
  new Request("http://x/source-assets", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

// Lucas-shaped: 12 scanned photos, 2 logos without dimensions, all stored.
function lucas() {
  const rows = []; const files = {};
  for (let i = 1; i <= 12; i++) {
    const [w, h] = i === 1 ? [1536, 2048] : i <= 3 ? [1366, 2048] : i <= 7 ? [1066, 1600] : i === 8 ? [980, 1307] : [950, 1200];
    const path = `${CLIENT}/scan/photo-${i}.jpg`;
    files[path] = jpeg(w, h, null, i);
    rows.push(row({ id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, storage_path: path, width: w, height: h, size_bytes: files[path].byteLength }));
  }
  for (const [n, [w, h], kind] of [[13, [512, 512], "logo_primary"], [14, [192, 192], "logo_icon"]]) {
    const path = `${CLIENT}/scan/logo-${n}.png`;
    files[path] = png(w, h);
    rows.push(row({ id: `00000000-0000-4000-8000-0000000000${n}`, kind, label: kind, storage_path: path, width: null, height: null, mime_type: "image/png", size_bytes: 33 }));
  }
  return { rows, files };
}

test("callers: worker secret or teammate; portal 403, nobody 401, GET 405", async () => {
  const { fn } = fake({}, []);
  assert.equal((await fn.handle(req({ mode: "version" }))).status, 200);
  assert.equal((await fn.handle(req({ mode: "version" }, { "x-cron-secret": "cron" }))).status, 200);
  assert.equal((await fn.handle(req({ mode: "version" }, { Authorization: "Bearer portal" }))).status, 403);
  assert.equal((await fn.handle(req({ mode: "version" }, {}))).status, 401);
  assert.equal((await fn.handle(req({ mode: "version" }, { "x-cron-secret": "wrong" }))).status, 401);
  assert.equal((await fn.handle(new Request("http://x", { method: "GET" }))).status, 405);
  assert.equal((await fn.handle(req({ mode: "publish", client_id: CLIENT }))).status, 400);
  assert.equal((await fn.handle(req({ mode: "inventory", client_id: "22222222-2222-4222-8222-222222222222" }))).status, 404);
});

test("inventory (dry run) of a Lucas-shaped library writes nothing and proposes 14 records", async () => {
  const { rows, files } = lucas();
  const { fn, calls } = fake(files, rows);
  const res = await fn.handle(req({ mode: "inventory", client_id: CLIENT }));
  const body = await res.json();
  assert.equal(res.status, 200); assert.equal(body.writes, false); assert.equal(calls.record.length, 0);
  assert.deepEqual(body.summary, { assets: 14, stored: 14, link_only: 0, missing: 0, unreadable: 0, unsupported: 0, would_record: 14, unchanged: 0, would_reset_review: 0 });
  const logo = body.assets.find((a) => a.kind === "logo_icon");
  assert.deepEqual([logo.measured.width, logo.measured.height], [192, 192]);
  assert.equal(body.link_only_import, null);
  assert.ok(body.assets.every((a) => a.measured.content_hash === hex(files[a.storage_path])));
});

test("inventory reports link-only and missing files separately, with the brand-scan import", async () => {
  const { rows, files } = lucas();
  rows.push(row({ id: "00000000-0000-4000-8000-000000000099", storage_path: null, source: "link", url: "https://lucas.test/x.jpg", label: "Linked" }));
  delete files[rows[3].storage_path];
  const { fn, calls } = fake(files, rows);
  const body = await (await fn.handle(req({ mode: "inventory", client_id: CLIENT }))).json();
  assert.equal(body.summary.link_only, 1); assert.equal(body.summary.missing, 1); assert.equal(body.summary.would_record, 13);
  assert.equal(body.link_only_import.body.import[0].url, "https://lucas.test/x.jpg");
  assert.equal(calls.read.length, 14, "a link-only asset is never read as a stored file");
  assert.equal(calls.record.length, 0);
});

test("hash records only the named assets, bound to the inventoried hash; a second run is unchanged", async () => {
  const { rows, files } = lucas();
  const { fn, calls } = fake(files, rows);
  const inv = await (await fn.handle(req({ mode: "inventory", client_id: CLIENT }))).json();
  const expect = Object.fromEntries(inv.assets.slice(0, 3).map((a) => [a.asset_id, a.measured.content_hash]));
  const body = await (await fn.handle(req({ mode: "hash", client_id: CLIENT, expect }))).json();
  assert.equal(body.summary.recorded, 3); assert.equal(calls.record.length, 3);
  assert.deepEqual(Object.keys(calls.record[0]).sort(), ["asset_id", "byte_size", "content_hash", "content_type", "expected_hash", "height", "measured_by", "orientation", "raw_height", "raw_width", "storage_path", "width"]);
  assert.ok(calls.record.every((p) => p.expected_hash === null && expect[p.asset_id] === p.content_hash));
  // The rows now carry their hashes: nothing to record.
  for (const r of rows.slice(0, 3)) r.content_hash = expect[r.id];
  const again = await (await fn.handle(req({ mode: "hash", client_id: CLIENT, expect }))).json();
  assert.equal(again.summary.unchanged, 3); assert.equal(calls.record.length, 3);
});

test("hash refuses bytes that changed since the inventory, and never records them", async () => {
  const { rows, files } = lucas();
  const { fn, calls } = fake(files, rows);
  const inv = await (await fn.handle(req({ mode: "inventory", client_id: CLIENT }))).json();
  const a = inv.assets[0];
  files[a.storage_path] = jpeg(1536, 2048, null, 999); // replaced after the dry run
  const body = await (await fn.handle(req({ mode: "hash", client_id: CLIENT, expect: { [a.asset_id]: a.measured.content_hash } }))).json();
  assert.equal(body.results[0].status, "refused"); assert.equal(body.results[0].code, "changed_since_inventory");
  assert.equal(body.results[0].measured, hex(files[a.storage_path]));
  assert.equal(calls.record.length, 0);
});

test("hash: a database refusal for one asset is reported and the rest still record", async () => {
  const { rows, files } = lucas();
  let n = 0;
  const { fn } = fake(files, rows, {
    record: async (p) => { n++; if (n === 2) throw new Error("object_missing: The stored file is not in the brand-assets bucket"); return { asset_id: p.asset_id, status: "hashed" }; },
  });
  const inv = await (await fn.handle(req({ mode: "inventory", client_id: CLIENT }))).json();
  const expect = Object.fromEntries(inv.assets.slice(0, 3).map((a) => [a.asset_id, a.measured.content_hash]));
  const body = await (await fn.handle(req({ mode: "hash", client_id: CLIENT, expect }))).json();
  assert.deepEqual(body.results.map((r) => r.status), ["hashed", "refused", "hashed"]);
  assert.equal(body.results[1].code, "object_missing");
});

test("hash input is validated: an expect map is required, hashes are hex, other clients' assets are refused", async () => {
  const { rows, files } = lucas();
  const { fn, calls } = fake(files, rows);
  assert.equal((await fn.handle(req({ mode: "hash", client_id: CLIENT }))).status, 400);
  assert.equal((await fn.handle(req({ mode: "hash", client_id: CLIENT, expect: { [rows[0].id]: "abc" } }))).status, 400);
  const tooMany = Object.fromEntries(Array.from({ length: MAX_ASSETS + 1 }, (_, i) => [`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, "a".repeat(64)]));
  assert.equal((await fn.handle(req({ mode: "hash", client_id: CLIENT, expect: tooMany }))).status, 400);
  const body = await (await fn.handle(req({ mode: "hash", client_id: CLIENT, expect: { "33333333-3333-4333-8333-333333333333": "a".repeat(64) } }))).json();
  assert.equal(body.results[0].code, "not_this_client"); assert.equal(calls.record.length, 0);
});

test("summarize counts what a dry run found", () => {
  const s = summarize([{ stored: "present", action: "record", issues: [], review_reset: true }, { stored: "no_file", action: "skip", issues: [{ code: "link_only" }], review_reset: false }]);
  assert.deepEqual(s, { assets: 2, stored: 1, link_only: 1, missing: 0, unreadable: 0, unsupported: 0, would_record: 1, unchanged: 0, would_reset_review: 1 });
});
