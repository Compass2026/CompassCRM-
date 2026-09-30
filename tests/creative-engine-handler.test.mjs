// creative-engine's request boundary (supabase/functions/creative-engine/
// handler.ts) over a fake store and the real renderer: who may call, that a
// dry run writes nothing, that every refusal happens before any write, the
// template_preview write path through 0054's functions, retries and
// idempotency. The database side of those functions is the sandbox's
// creative_engine / creative_overlay_roles tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeEngine } from "../scripts/lib/creative-engine-node.mjs";
import { createCreativeEngine } from "../supabase/functions/creative-engine/handler.ts";
import { lucasTemplates, findTemplate } from "../supabase/functions/creative-engine/registry.ts";
import { specHash, jsonbText, sha256Hex } from "../supabase/functions/creative-engine/spec.ts";
import { FACTS, P, RR, C, clone, syntheticSources, requestFor } from "./helpers/creative-fixtures.mjs";

function fakeStore({ facts, bytes, registered = true, beginReuse = null, uploadFails = false } = {}) {
  const calls = [];
  const runs = [];
  const tpl = new Map();
  const store = {
    calls,
    async secret(name) { return name === "SYNC_CRON_SECRET" ? "cron-secret" : null; },
    async caller(jwt) { return jwt === "team-jwt" ? { member: "m-1" } : jwt === "portal-jwt" ? { member: null } : "none"; },
    async facts(id) { calls.push(["facts", id]); return id === facts.client.id ? facts : null; },
    async read(path) {
      calls.push(["read", path]);
      const a = facts.assets.find((x) => x.storage_path === path);
      return bytes.get(a.content_hash);
    },
    async template(key, version) {
      calls.push(["template", key, version]);
      if (!registered) return null;
      const t = findTemplate(key, version);
      return t ? { id: `tpl-${key}`, spec_hash: typeof registered === "string" ? registered : await specHash(t.spec), status: "published" } : null;
    },
    async registerTemplate(p) {
      calls.push(["registerTemplate", p.key]);
      const hash = await specHash(p.spec);
      const existing = tpl.get(p.key);
      tpl.set(p.key, hash);
      return { template_id: `tpl-${p.key}`, spec_hash: hash, registered: !existing };
    },
    async beginRun(p) {
      calls.push(["beginRun", p]);
      const same = runs.find((r) => r.brief_hash === p.brief_hash && r.status !== "failed");
      if (beginReuse) return beginReuse;
      if (same) return { run_id: same.id, status: same.status, reused: true, creative_asset_id: same.asset };
      const run = { id: `run-${runs.length + 1}`, brief_hash: p.brief_hash, status: "rendering", asset: null };
      runs.push(run);
      return { run_id: run.id, status: "rendering", reused: false };
    },
    async upload(path, png, type) {
      calls.push(["upload", path, png.byteLength, type]);
      if (uploadFails) throw new Error("storage unavailable");
    },
    async write(p) {
      calls.push(["write", p]);
      const run = runs.find((r) => r.id === p.run_id);
      run.status = "succeeded";
      run.asset = `asset-${p.asset.content_hash.slice(0, 8)}`;
      return { creative_asset_id: run.asset, storage_path: `${facts.client.id}/${p.asset.content_hash}.png`, new: true, preview: true };
    },
    async failRun(p) {
      calls.push(["failRun", p]);
      runs.find((r) => r.id === p.run_id).status = "failed";
    },
  };
  return store;
}
const writes = (store) => store.calls.filter(([k]) => ["beginRun", "upload", "write", "failRun", "registerTemplate"].includes(k));
const post = (fn, body, auth = { "x-cron-secret": "cron-secret" }) =>
  fn.handle(new Request("https://x/functions/v1/creative-engine", { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body) }));

async function setup(opts = {}) {
  const src = await syntheticSources();
  const store = fakeStore({ facts: opts.facts ?? src.facts, bytes: src.bytes, ...opts });
  return { store, fn: createCreativeEngine({ store, engine: nodeEngine }), src };
}
const T = (key) => findTemplate(key, 1);
const body = async (key, over = {}) => ({ mode: "preview", ...(await requestFor(T(key), over)) });

test("callers: the worker's cron secret or a teammate; nobody else", async () => {
  const { fn } = await setup();
  assert.equal((await post(fn, { mode: "version" }, {})).status, 401);
  assert.equal((await post(fn, { mode: "version" }, { authorization: "Bearer portal-jwt" })).status, 403);
  assert.equal((await post(fn, { mode: "version" }, { authorization: "Bearer team-jwt" })).status, 200);
  assert.equal((await post(fn, { mode: "render-anything" })).status, 400);
});

test("version: the renderer and every template version with its spec hash", async () => {
  const { fn } = await setup();
  const r = await (await post(fn, { mode: "version" })).json();
  assert.match(r.renderer, /^creative-engine\/1 resvg-wasm@2\.6\.2 opentype\.js@1\.3\.4$/);
  assert.equal(r.templates.length, 15);
  for (const t of r.templates) assert.equal(t.spec_hash, await specHash(findTemplate(t.key, t.version).spec));
});

test("plan: a dry run renders and answers the hashes; it writes nothing", async () => {
  const { fn, store } = await setup();
  const res = await post(fn, { ...(await body("lucas-service-spotlight-gbp")), mode: "plan" });
  const r = await res.json();
  assert.equal(res.status, 200, JSON.stringify(r));
  assert.equal(r.writes, false);
  assert.match(r.content_hash, /^[0-9a-f]{64}$/);
  assert.equal(r.overlay[0].text, "Roof Replacement");
  assert.deepEqual(writes(store), []);
});

test("requests carry references only: a text field is refused", async () => {
  const { fn, store } = await setup();
  const res = await post(fn, { ...(await body("lucas-service-spotlight-gbp")), headline: "Best roofer in Missouri" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /references only/);
  assert.deepEqual(writes(store), []);
});

test("preview refusals happen before any write: unregistered, other spec, excluded photo, unusable claim", async () => {
  let s = await setup({ registered: false });
  let r = await post(s.fn, await body("lucas-service-spotlight-gbp"));
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, "template_not_registered");
  assert.deepEqual(writes(s.store), []);

  s = await setup({ registered: "sha256:" + "1".repeat(64) });
  r = await post(s.fn, await body("lucas-service-spotlight-gbp"));
  assert.equal((await r.json()).code, "template_version_mismatch");
  assert.deepEqual(writes(s.store), []);

  s = await setup();
  r = await post(s.fn, await body("lucas-service-spotlight-gbp", { photos: { photos: [P.excluded] } }));
  const j = await r.json();
  assert.deepEqual([r.status, j.code], [409, "source_not_approved"]);
  r = await post(s.fn, await body("lucas-service-spotlight-gbp", { bindings: { headline: { role: "service_name", source_id: RR }, subline: { role: "claim", source_id: C.free } } }));
  assert.equal((await r.json()).code, "claim_unusable");
  assert.deepEqual(writes(s.store), []);
  assert.ok(!s.store.calls.some(([k]) => k === "read"), "no source is even read when the plan refuses");
});

test("preview: begin a template_preview run, upload at the content address, record through creative_write", async () => {
  const { fn, store, src } = await setup();
  const res = await post(fn, await body("lucas-real-work-gbp"), { authorization: "Bearer team-jwt" });
  const r = await res.json();
  assert.equal(res.status, 200, JSON.stringify(r));
  const [[, begin]] = store.calls.filter(([k]) => k === "beginRun");
  assert.equal(begin.purpose, "template_preview");
  assert.equal(begin.reason, "preview");
  assert.equal(begin.strategy, "source_photo");
  assert.deepEqual([begin.requested_via, begin.requested_by], ["team", "m-1"]);
  assert.equal(begin.template_id, "tpl-lucas-real-work-gbp");
  assert.equal(begin.brief_hash, "sha256:" + await sha256Hex(jsonbText(begin.brief)), "brief_hash is creative_spec_hash(brief)");
  const [[, path, size, type]] = store.calls.filter(([k]) => k === "upload");
  assert.equal(path, `${FACTS.client.id}/${r.content_hash}.png`);
  assert.deepEqual([size, type], [r.size_bytes, "image/png"]);
  const [[, w]] = store.calls.filter(([k]) => k === "write");
  assert.equal(w.run_id, begin.run_id ?? "run-1");
  assert.deepEqual(w.asset.overlay.map((o) => o.role), ["service_name", "template_label", "standing_cta", "phone", "website"]);
  assert.equal(w.asset.overlay.find((o) => o.role === "template_label").source_id, "tpl-lucas-real-work-gbp");
  assert.deepEqual(w.sources.map((s) => s.role), ["photo", "photo", "photo", "logo"]);
  for (const s of w.sources) assert.equal(s.source_content_hash, src.facts.assets.find((a) => a.id === s.brand_asset_id).content_hash);
  assert.equal(r.writes, true);
});

test("idempotent: the same preview again reuses the recorded run and asset, uploading nothing", async () => {
  const { fn, store } = await setup();
  const b = await body("lucas-seasonal-gbp");
  const first = await (await post(fn, b)).json();
  const second = await (await post(fn, b)).json();
  assert.equal(second.reused, true);
  assert.equal(second.creative_asset_id, first.creative_asset_id);
  assert.equal(second.content_hash, first.content_hash);
  assert.equal(store.calls.filter(([k]) => k === "upload").length, 1);
  assert.equal(store.calls.filter(([k]) => k === "write").length, 1);
});

test("a run already rendering the same preview is not started twice", async () => {
  const { fn, store } = await setup({ beginReuse: { run_id: "run-busy", status: "rendering", reused: true, creative_asset_id: null } });
  const res = await post(fn, await body("lucas-seasonal-gbp"));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "run_in_progress");
  assert.equal(store.calls.filter(([k]) => k === "upload").length, 0);
});

test("a failure after the run began fails the run; the retry begins a new run and succeeds", async () => {
  const { fn, store, src } = await setup({ uploadFails: true });
  const b = await body("lucas-service-light-gbp");
  const res = await post(fn, b);
  assert.equal(res.status, 500);
  assert.deepEqual(store.calls.filter(([k]) => k === "failRun").map(([, p]) => p.run_id), ["run-1"]);
  const ok = createCreativeEngine({ store: Object.assign(store, { upload: async () => {} }), engine: nodeEngine });
  const again = await (await post(ok, b)).json();
  assert.equal(again.run_id, "run-2", "a failed run is not reused");
  assert.equal(again.writes, true);
  void src;
});

test("register: every template through creative_register_template; repeating is a no-op", async () => {
  const { fn, store } = await setup();
  const r1 = await (await post(fn, { mode: "register" })).json();
  assert.equal(r1.templates.length, 15);
  assert.ok(r1.templates.every((t) => t.registered));
  const r2 = await (await post(fn, { mode: "register", keys: ["lucas-real-work-gbp"] })).json();
  assert.deepEqual(r2.templates.map((t) => [t.key, t.registered]), [["lucas-real-work-gbp", false]]);
  const bad = createCreativeEngine({ store: { ...store, registerTemplate: async () => ({ template_id: "x", spec_hash: "sha256:" + "0".repeat(64), registered: true }) }, engine: nodeEngine });
  await assert.rejects(post(bad, { mode: "register", keys: ["lucas-real-work-gbp"] }), /spec hash disagreement/);
});

test("a changed source between plan and preview is refused at render (bytes re-read and re-hashed)", async () => {
  const src = await syntheticSources();
  const facts = clone(src.facts);
  const store = fakeStore({ facts, bytes: src.bytes });
  store.read = async (path) => {
    const a = facts.assets.find((x) => x.storage_path === path);
    const b = src.bytes.get(a.content_hash);
    return a.id === P.hero ? new Uint8Array([...b, 1]) : b;
  };
  const fn = createCreativeEngine({ store, engine: nodeEngine });
  const res = await post(fn, await body("lucas-service-spotlight-gbp"));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "source_hash_mismatch");
  assert.deepEqual(writes(store), []);
});

test("every template's pilot request renders through the handler (dry run)", async () => {
  const { fn } = await setup();
  for (const t of lucasTemplates()) {
    const res = await post(fn, { ...(await body(t.key)), mode: "plan" });
    assert.equal(res.status, 200, t.key);
  }
});
