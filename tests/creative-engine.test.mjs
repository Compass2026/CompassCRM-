// Creative Engine renderer, templates and governance
// (supabase/functions/creative-engine/). Real engine: the pinned resvg WASM
// and fonts, exactly as the Edge Function runs them. Facts are the read-only
// production snapshot of Lucas (tests/fixtures/creative-lucas-facts.json);
// photos and the logo are synthetic stand-ins with the production sizes,
// generated here by the same rasteriser, so every hash below is reproducible.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import opentype from "opentype.js";
import { Resvg } from "@resvg/resvg-wasm";
import { nodeEngine, rasterizeWith } from "../scripts/lib/creative-engine-node.mjs";
import { fixture as templatesFixture } from "../scripts/creative-templates-fixture.mjs";
import { createEngine, render, checkPng, RENDERER_ID } from "../supabase/functions/creative-engine/render.ts";
import { plan, displayWebsite, serviceMatches, GLOBAL_BLOCKED } from "../supabase/functions/creative-engine/govern.ts";
import { focalCrop } from "../supabase/functions/creative-engine/crop.ts";
import { layout, measure } from "../supabase/functions/creative-engine/text.ts";
import { jsonbText, lintSpec, specHash, contrast } from "../supabase/functions/creative-engine/spec.ts";
import { lucasTemplates, findTemplate } from "../supabase/functions/creative-engine/registry.ts";
import { LUCAS } from "../supabase/functions/creative-engine/kits.ts";
import { EMBEDDED_FONTS } from "../supabase/functions/creative-engine/fonts.generated.ts";

import { read, FACTS, sha, clone, RR, SIDING, C, P, LOGO, ORANGE, syntheticSources, requestFor } from "./helpers/creative-fixtures.mjs";
const T = (key) => findTemplate(key, 1);
async function refusal(fn) {
  try { await fn(); } catch (e) { return e.code ?? `error: ${e.message}`; }
  return "rendered";
}
async function planCode(t, facts, over) {
  return refusal(async () => plan(t.spec, facts, await requestFor(t, over)));
}
// Decode a PNG by drawing it through the same rasteriser; returns RGBA pixels.
function pixels(png, w, h) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><image width="${w}" height="${h}" href="data:image/png;base64,${Buffer.from(png).toString("base64")}"/></svg>`;
  const r = new Resvg(svg, { fitTo: { mode: "original" } });
  const img = r.render();
  const px = img.pixels.slice();
  img.free(); r.free();
  return { at: (x, y) => { const i = (y * w + x) * 4; return [px[i], px[i + 1], px[i + 2]]; } };
}
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

// ── Templates and specs ─────────────────────────────────────────────────────
test("fifteen Lucas template versions: five families × Business Profile, Facebook, Instagram, sized per channel", () => {
  const all = lucasTemplates();
  assert.equal(all.length, 15);
  assert.equal(new Set(all.map((t) => `${t.key}@${t.version}`)).size, 15);
  for (const t of all) {
    assert.equal(t.version, 1);
    assert.equal(t.mime_type, "image/png");
    const [w, h] = t.channel === "google_business" ? [1200, 900] : [1080, 1350];
    assert.deepEqual([t.output_width, t.output_height, t.spec.canvas.width, t.spec.canvas.height], [w, h, w, h], t.key);
  }
  assert.deepEqual([...new Set(all.map((t) => t.spec.family))].sort(),
    ["real_work", "seasonal", "service_light", "service_spotlight", "trust_know_how"]);
  assert.ok(!all.some((t) => /review|team|offer/.test(t.key)), "Review Spotlight, Team & Community and Offer mode are not built");
});

test("every spec passes the lint: palette only, contrast, canvas and safe area", () => {
  for (const t of lucasTemplates()) assert.deepEqual(lintSpec(t.spec), [], t.key);
  const bad = clone(T("lucas-service-light-gbp").spec);
  bad.elements.find((e) => e.type === "stack").items[2].style.color = "muted";
  assert.match(lintSpec(bad).join(" "), /subline: contrast/);
  const outside = clone(T("lucas-service-spotlight-gbp").spec);
  outside.elements.find((e) => e.type === "stack").x = 40;
  assert.match(lintSpec(outside).join(" "), /safe area/);
});

test("specs carry the approved Lucas system and no client fact or claim", () => {
  const retired = ["#ed202b", "#03bed7", "#3ca8f0", "#9c603c", "#222222", "#777777"];
  for (const t of lucasTemplates()) {
    assert.deepEqual(t.spec.palette, { charcoal: "#0d0f10", panel: "#1a1d1f", blue: "#128fb1", sky: "#72d2e4", text: "#f0f4f8", muted: "#8fa3b1" });
    const json = JSON.stringify(t.spec).toLowerCase();
    for (const c of retired) assert.ok(!json.includes(c), `${t.key} uses retired ${c}`);
    for (const fact of [FACTS.client.phone, "lucasconstructionmo", FACTS.brand.tagline, FACTS.brand.standing_cta,
      ...FACTS.claims.map((c) => c.claim), ...FACTS.services.map((s) => s.name)]) {
      assert.ok(!json.includes(fact.toLowerCase()), `${t.key} holds "${fact}"`);
    }
    assert.deepEqual([...new Set(Object.values(t.spec.fonts).map((f) => f.family))].sort(), ["Montserrat", "Poppins"]);
    assert.equal(t.spec.logo_asset_id, LOGO);
  }
  for (const f of EMBEDDED_FONTS) assert.equal(sha(Buffer.from(f.base64, "base64")), f.sha256, f.id);
});

test("spec hash = Postgres creative_spec_hash text; the committed fixture is current", async () => {
  assert.equal(jsonbText({ bb: 1, a: { ccc: [1, "x", true], d: null } }), '{"a": {"d": null, "ccc": [1, "x", true]}, "bb": 1}');
  assert.equal(jsonbText({ é: 1, z: 2 }), '{"z": 2, "é": 1}', "keys order by byte length, then bytes");
  assert.equal(jsonbText({ n: 0.514, s: "a\"b\n" }), '{"n": 0.514, "s": "a\\"b\\n"}');
  assert.deepEqual(JSON.parse(read("./fixtures/creative-lucas-templates.json")), JSON.parse(JSON.stringify(await templatesFixture())),
    "run node scripts/creative-templates-fixture.mjs");
  const a = await specHash(T("lucas-real-work-gbp").spec);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.equal(await specHash(clone(T("lucas-real-work-gbp").spec)), a);
});

// ── Focal-point crop ────────────────────────────────────────────────────────
test("crop: the largest region of the box's shape, centred on the focal point and clamped to the edges", () => {
  const c = focalCrop({ width: 1536, height: 2048 }, { x: 0.514, y: 0.323 }, { w: 1080, h: 790 }, "hero");
  assert.equal(c.w, 1536);
  assert.ok(Math.abs(c.h - 1536 * 790 / 1080) < 0.01);
  assert.ok(Math.abs(c.y + c.h / 2 - 0.323 * 2048) < 0.01, "focal y centred");
  assert.ok(c.scale <= 1);
  const top = focalCrop({ width: 1536, height: 2048 }, { x: 0.5, y: 0 }, { w: 1080, h: 790 }, "hero");
  assert.equal(top.y, 0);
  const bottom = focalCrop({ width: 1536, height: 2048 }, { x: 0.5, y: 1 }, { w: 1080, h: 790 }, "hero");
  assert.ok(Math.abs(bottom.y + bottom.h - 2048) < 0.01);
  // Landscape source into a portrait box: full height, x follows the focal point.
  const land = focalCrop({ width: 2400, height: 1600 }, { x: 0.8, y: 0.5 }, { w: 400, h: 600 }, "cell");
  assert.equal(land.h, 1600);
  assert.ok(Math.abs(land.x + land.w / 2 - 0.8 * 2400) < 0.01 || land.x + land.w === 2400);
  assert.ok(Math.abs(land.w - 1600 * 400 / 600) < 0.01);
});

test("crop: never enlarges a photo, and needs a reviewed focal point", () => {
  assert.throws(() => focalCrop({ width: 950, height: 1200 }, { x: 0.5, y: 0.5 }, { w: 1080, h: 790 }, "hero"), (e) => e.code === "source_too_small");
  assert.doesNotThrow(() => focalCrop({ width: 950, height: 1200 }, { x: 0.5, y: 0.5 }, { w: 537, h: 450 }, "cell"));
  assert.throws(() => focalCrop({ width: 950, height: 1200 }, { x: NaN, y: 0.5 }, { w: 100, h: 100 }, "cell"), (e) => e.code === "focal_point_missing");
});

// ── Text ────────────────────────────────────────────────────────────────────
test("text: measured from the pinned fonts, wrapped at a fixed size, refused (never shrunk) when it does not fit", async () => {
  const e = await nodeEngine();
  const style = { font: "montserrat-800", size: 52, line_height: 56, color: "text", transform: "uppercase" };
  const one = layout(e.fonts["montserrat-800"], "Roof Replacement", style, 900, 1, "headline");
  assert.equal(one.lines.length, 1);
  const two = layout(e.fonts["montserrat-800"], "Roof Replacement", style, 460, 3, "headline");
  assert.deepEqual(two.lines.map((l) => l.text), ["ROOF", "REPLACEMENT"]);
  assert.throws(() => layout(e.fonts["montserrat-800"], "Roof Replacement", style, 460, 1, "headline"), (x) => x.code === "copy_does_not_fit");
  assert.throws(() => layout(e.fonts["montserrat-800"], "Supercalifragilistic", style, 300, 3, "headline"), (x) => x.code === "copy_does_not_fit");
  assert.throws(() => layout(e.fonts["poppins-500"], "Roofs 🏠", { ...style, font: "poppins-500" }, 900, 1, "subline"), (x) => x.code === "unsupported_character");
  const w1 = measure(e.fonts["montserrat-700"], "ROOFING", { ...style, font: "montserrat-700" });
  const w2 = measure(e.fonts["montserrat-700"], "ROOFING", { ...style, font: "montserrat-700", tracking: 3 });
  assert.ok(Math.abs(w2 - w1 - 18) < 1e-6, "tracking adds 3 px between 7 glyphs");
  // Every governed Lucas string the pilot draws has every glyph.
  for (const s of [FACTS.client.name, FACTS.client.phone, displayWebsite(FACTS.client.website_url), FACTS.brand.tagline,
    FACTS.brand.standing_cta.toUpperCase(), ...FACTS.claims.map((c) => c.claim), ...FACTS.services.map((x) => x.name.toUpperCase())]) {
    for (const f of Object.values(e.fonts)) assert.doesNotThrow(() => measure(f, s, style), s);
  }
});

test("fonts: a font whose bytes do not match the pinned hash stops the engine", async () => {
  const good = EMBEDDED_FONTS[0].base64;
  EMBEDDED_FONTS[0].base64 = Buffer.from("tampered").toString("base64");
  try {
    await assert.rejects(createEngine({ parseFont: (b) => opentype.parse(b), rasterize: () => new Uint8Array() }), /pinned hash/);
  } finally {
    EMBEDDED_FONTS[0].base64 = good;
  }
});

// ── Governance ──────────────────────────────────────────────────────────────
test("governed copy: text is resolved from the record; the caller cannot supply it", async () => {
  const t = T("lucas-service-spotlight-gbp");
  const p = await plan(t.spec, FACTS, await requestFor(t));
  const byslot = Object.fromEntries(p.lines.map((l) => [l.slot, l]));
  assert.equal(byslot.headline.text, "Roof Replacement");
  assert.equal(byslot.eyebrow.text, "Roofing");
  assert.equal(byslot.cta.text, "Request a quote");
  assert.equal(byslot.phone.text, "(636) 459-9328");
  assert.equal(byslot.website.text, "lucasconstructionmo.com");
  assert.deepEqual(p.lists.points.map((l) => l.text), ["Owens Corning Preferred Contractor", "BBB Accredited Business since 6/30/2025"]);
  assert.equal(await planCode(t, FACTS, { bindings: { headline: { role: "service_name", source_id: RR, text: "Best roofer" } } }), "rendered",
    "a text field in a binding is ignored — the name is resolved from the record");
  const q = await plan(t.spec, FACTS, await requestFor(t, { bindings: { headline: { role: "service_name", source_id: RR, text: "Best roofer" } } }));
  assert.equal(q.lines.find((l) => l.slot === "headline").text, "Roof Replacement");
});

test("governed copy refusals: unusable and unavailable claims, fixed slots, roles, words, services", async () => {
  const ss = T("lucas-service-spotlight-gbp");
  const trust = T("lucas-trust-know-how-gbp");
  const withSub = (id) => ({ bindings: { headline: { role: "service_name", source_id: RR }, subline: { role: "claim", source_id: id } } });
  assert.equal(await planCode(ss, FACTS, withSub(C.free)), "claim_unusable", "unverified Free quotes offered");
  assert.equal(await planCode(ss, FACTS, withSub(C.warranty)), "unavailable_claim", "warranty waits on owner confirmation");
  assert.equal(await planCode(ss, FACTS, withSub(C.reviews)), "unavailable_claim", "review counts");
  assert.equal(await planCode(ss, FACTS, withSub(C.address)), "unavailable_claim", "street address");
  assert.equal(await planCode(trust, FACTS, { bindings: { headline: { role: "claim", source_id: C.storm }, points: [{ role: "claim", source_id: C.dur }, { role: "claim", source_id: C.bbb }] } }),
    "too_many_words", "a nine-word claim is not a headline");
  assert.equal(await planCode(ss, FACTS, { bindings: { headline: { role: "service_name", source_id: RR }, cta: { role: "tagline" } } }), "slot_is_fixed");
  assert.equal(await planCode(ss, FACTS, { bindings: { headline: { role: "tagline" } } }), "role_not_allowed");
  assert.equal(await planCode(ss, FACTS, { bindings: { headline: { role: "service_name", source_id: RR }, badge: { role: "claim", source_id: C.oc } } }), "unknown_slot");
  assert.equal(await planCode(ss, FACTS, { bindings: {} }), "missing_required_slot");
  assert.equal(await planCode(ss, FACTS, { service_id: SIDING, bindings: { headline: { role: "service_name", source_id: RR } } }), "service_mismatch");
  const retired = clone(FACTS);
  retired.services.find((s) => s.id === RR).status = "retired";
  assert.equal(await planCode(ss, retired, {}), "service_not_approved");
  const noCta = clone(FACTS);
  noCta.brand.standing_cta = null;
  assert.equal(await planCode(ss, noCta, {}), "governed_value_missing");
  const off = clone(FACTS);
  off.client.status = "offboarded";
  assert.equal(await planCode(ss, off, {}), "client_offboarded");
  for (const [text, id] of [["Free roof check", "free"], ["24/7 storm response", "24/7"], ["Same-day repairs", "same-day"],
    ["Licensed and bonded", "licensed/bonded/insured"], ["500+ roofs installed", "counts"], ["Serving since 2018", "founding year"],
    ["139 Google reviews", "reviews"], ["The #1 roofer", "superlatives"], ["Best roofs in town", "superlatives"],
    ["Guaranteed for life", "guarantees"], ["Emergency roof repair", "emergency"]]) {
    assert.ok(GLOBAL_BLOCKED.find((b) => b.id === id).re.test(text), text);
  }
  for (const ok of ["Owens Corning Preferred Contractor", "BBB Accredited Business since 6/30/2025", "Installs Owens Corning Duration shingles",
    "Roofing, siding, guttering, fascia and soffit contractor", "Built on local roots. Driven by trust.", "Request a quote"]) {
    assert.ok(!GLOBAL_BLOCKED.some((b) => b.re.test(ok)), ok);
  }
  for (const market of ["St. Louis County", "Chesterfield", "Ballwin", "Wildwood", "Florissant", "Roof inspections", "Lifetime warranty"]) {
    assert.ok(LUCAS.blocked_phrases.some((src) => new RegExp(src, "i").test(market)), market);
  }
});

test("photo governance: approved own work only, unchanged, reviewed, on topic, no people, hero-grade where it leads", async () => {
  const ss = T("lucas-service-spotlight-gbp");
  const photo = (id) => ({ photos: { photos: [id] } });
  assert.equal(await planCode(ss, FACTS, photo(P.excluded)), "source_not_approved", "excluded");
  const unreviewed = clone(FACTS);
  unreviewed.assets.find((a) => a.id === P.hero).creative_use = "unreviewed";
  assert.equal(await planCode(ss, unreviewed, {}), "source_not_approved", "unreviewed");
  assert.equal(await planCode(ss, FACTS, photo(P.owner)), "source_not_own_work", "the approved team photo is not own work");
  const people = clone(FACTS);
  Object.assign(people.assets.find((a) => a.id === P.owner), { depicts_own_work: true });
  assert.equal(await planCode(ss, people, photo(P.owner)), "people_imagery_blocked", "people need a consent record");
  const withdrawn = clone(FACTS);
  withdrawn.assets = withdrawn.assets.filter((a) => a.id !== P.hero);
  assert.equal(await planCode(ss, withdrawn, {}), "source_withdrawn");
  assert.equal(await planCode(ss, FACTS, { expected_source_hashes: { [P.hero]: "0".repeat(64) } }), "source_changed", "stale hash");
  assert.equal(await planCode(ss, FACTS, photo(P.crane)), "source_below_hero", "980 px is not hero-grade");
  assert.equal(await planCode(T("lucas-trust-know-how-facebook"), FACTS, photo(P.crane)), "source_too_small", "no upscaling into a 1080-wide slot");
  assert.equal(await planCode(ss, FACTS, { service_id: SIDING, bindings: { headline: { role: "service_name", source_id: SIDING } } }), "photo_off_topic");
  assert.equal(await planCode(ss, FACTS, { photos: { photos: [P.hero, P.done] } }), "photo_count");
  const nofocal = clone(FACTS);
  Object.assign(nofocal.assets.find((a) => a.id === P.hero), { focal_x: null, focal_y: null });
  assert.equal(await planCode(ss, nofocal, {}), "focal_point_missing");
  const logoOff = clone(FACTS);
  logoOff.assets.find((a) => a.id === LOGO).creative_use = "excluded";
  assert.equal(await planCode(ss, logoOff, {}), "logo_not_approved");
  assert.ok(serviceMatches("Roof Replacement", ["residential roofing"]));
  assert.ok(serviceMatches("Gutter Installation & Repair", ["gutters"]));
  assert.ok(!serviceMatches("Storm Damage & Insurance Claims", ["roof", "architectural shingles"]));
  assert.ok(!serviceMatches("Holiday Lighting Installation", ["roof replacement"]));
});

test("labels: only the template's own, fixed ones; Real Work names no project location", async () => {
  const rw = T("lucas-real-work-gbp");
  assert.deepEqual(rw.spec.labels.map((l) => l.text), ["Our work"]);
  assert.equal(await planCode(rw, FACTS, { bindings: { eyebrow: { role: "template_label", source_id: "fall" }, headline: { role: "service_name", source_id: RR } } }), "label_unknown");
  assert.deepEqual(T("lucas-seasonal-gbp").spec.labels.map((l) => l.text), ["Spring", "Summer", "Fall", "Winter", "Storm season"]);
  for (const t of lucasTemplates()) {
    for (const e of t.spec.elements) {
      for (const it of e.type === "stack" ? e.items : [e]) {
        if (it.roles) assert.ok(!it.roles.some((r) => /location|city|area/.test(r)), `${t.key}.${it.slot}`);
      }
    }
  }
});

test("copy hash: the request can pin the exact governed copy; a change is refused", async () => {
  const t = T("lucas-service-spotlight-gbp");
  const p = await plan(t.spec, FACTS, await requestFor(t));
  assert.match(p.copy_hash, /^[0-9a-f]{64}$/);
  assert.equal(await planCode(t, FACTS, { expected_copy_hash: p.copy_hash }), "rendered");
  const changed = clone(FACTS);
  changed.client.phone = "(636) 555-0100";
  assert.equal(await planCode(t, changed, { expected_copy_hash: p.copy_hash }), "copy_hash_mismatch");
});

// ── Rendering ───────────────────────────────────────────────────────────────
test("render: identical inputs give identical bytes, even from a second engine", async () => {
  const { facts, reader } = await syntheticSources();
  const t = T("lucas-service-spotlight-gbp");
  const req = await requestFor(t);
  const a = await render(await nodeEngine(), t, facts, req, reader);
  const b = await render(await nodeEngine(), t, facts, req, reader);
  const fresh = await createEngine({ parseFont: (buf) => opentype.parse(buf), rasterize: rasterizeWith(Resvg) });
  const c = await render(fresh, t, facts, req, reader);
  assert.equal(a.content_hash, sha(a.png));
  assert.deepEqual([b.content_hash, c.content_hash], [a.content_hash, a.content_hash]);
  assert.equal(a.brief_hash, b.brief_hash);
  assert.equal(a.brief.renderer, RENDERER_ID);
  assert.equal(a.brief.template.spec_hash, await specHash(t.spec));
  assert.deepEqual(a.brief.photos.map((p) => p.content_hash), [facts.assets.find((x) => x.id === P.hero).content_hash]);
});

// Regenerate (only after a deliberate renderer / font / template version
// change): CREATIVE_WRITE_GOLDEN=1 node --test tests/creative-engine.test.mjs
const GOLDEN_KEYS = ["lucas-service-spotlight-gbp", "lucas-trust-know-how-facebook", "lucas-real-work-gbp", "lucas-service-light-instagram"];
test("render: golden hashes (pinned renderer, fonts and templates)", async () => {
  const { facts, reader } = await syntheticSources();
  if (process.env.CREATIVE_WRITE_GOLDEN === "1") {
    const out = {};
    for (const key of GOLDEN_KEYS) out[key] = (await render(await nodeEngine(), T(key), facts, await requestFor(T(key)), reader)).content_hash;
    fs.writeFileSync(new URL("./fixtures/creative-golden.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
  }
  const golden = JSON.parse(read("./fixtures/creative-golden.json"));
  assert.deepEqual(Object.keys(golden), GOLDEN_KEYS);
  for (const key of Object.keys(golden)) {
    const t = T(key);
    const r = await render(await nodeEngine(), t, facts, await requestFor(t), reader);
    assert.equal(r.content_hash, golden[key], `${key}: the render changed — a renderer, font or template change needs a new version`);
  }
});

test("render: every template renders the pilot content, valid PNG at the channel size, within the Edge budget", async () => {
  const { facts, reader } = await syntheticSources();
  const engine = await nodeEngine();
  const rss0 = process.memoryUsage().rss;
  let worst = 0;
  for (const t of lucasTemplates()) {
    const r = await render(engine, t, facts, await requestFor(t), reader);
    checkPng(r.png, t.output_width, t.output_height);
    assert.ok(r.size_bytes > 10_000 && r.size_bytes < 5 * 1024 * 1024, `${t.key} ${r.size_bytes} bytes`);
    assert.ok(r.overlay.length <= 12 && r.overlay[0].text.split(/\s+/).length <= 8, t.key);
    assert.ok(r.alt_text.length > 20);
    worst = Math.max(worst, r.ms.compose + r.ms.rasterize);
  }
  const rss = process.memoryUsage().rss;
  console.log(`  15 renders: slowest ${worst.toFixed(0)} ms (compose + rasterise); RSS ${(rss / 1e6).toFixed(0)} MB (+${((rss - rss0) / 1e6).toFixed(0)} MB)`);
  assert.ok(worst < 6000, `slowest render ${worst} ms`);
  assert.ok(rss < 1.5e9);
});

test("render: the output decodes, the brand ground and footer are where the spec puts them", async () => {
  const { facts, reader } = await syntheticSources();
  for (const [key, bg] of [["lucas-service-spotlight-gbp", "#0d0f10"], ["lucas-service-light-facebook", "#f0f4f8"]]) {
    const t = T(key);
    const r = await render(await nodeEngine(), t, facts, await requestFor(t), reader);
    const px = pixels(r.png, t.output_width, t.output_height);
    const band = t.channel === "google_business" ? 890 : 1340;
    assert.ok(near(px.at(Math.round(t.output_width / 2), band), hex("#1a1d1f")), `${key} footer panel`);
    const groundX = t.channel === "google_business" ? 20 : 20;
    const groundY = t.channel === "google_business" ? 600 : 30;
    assert.ok(near(px.at(groundX, groundY), hex(bg)), `${key} ground ${px.at(groundX, groundY)}`);
  }
});

test("render: the photo is cropped around its reviewed focal point (the marker lands where the crop puts it)", async () => {
  const { facts, reader } = await syntheticSources();
  for (const key of ["lucas-service-spotlight-facebook", "lucas-service-spotlight-gbp"]) {
    const t = T(key);
    const r = await render(await nodeEngine(), t, facts, await requestFor(t), reader);
    const slot = t.spec.elements.find((e) => e.type === "photo");
    const p = r.brief.photos[0];
    const s = slot.w / p.crop.w;
    const x = Math.round(slot.x + (p.focal.x * p.width - p.crop.x) * s);
    const y = Math.round(slot.y + (p.focal.y * p.height - p.crop.y) * s);
    assert.ok(near(pixels(r.png, t.output_width, t.output_height).at(x, y), hex(ORANGE), 12), `${key} focal marker at ${x},${y}`);
  }
});

test("render: optional slots may be left out; long governed lines are refused, not squeezed", async () => {
  const { facts, reader } = await syntheticSources();
  const t = T("lucas-service-spotlight-gbp");
  const minimal = await render(await nodeEngine(), t, facts, await requestFor(t, { bindings: { headline: { role: "service_name", source_id: RR } } }), reader);
  const full = await render(await nodeEngine(), t, facts, await requestFor(t), reader);
  assert.notEqual(minimal.content_hash, full.content_hash);
  assert.deepEqual(minimal.overlay.map((o) => o.role), ["service_name", "standing_cta", "phone", "website"]);
  const long = clone(facts);
  long.services.find((s) => s.id === RR).name = "Roof Replacement Restoration Specialists";
  const rw = T("lucas-real-work-facebook");
  const code = await refusal(async () => render(await nodeEngine(), rw, long, await requestFor(rw), reader));
  assert.equal(code, "copy_does_not_fit", "a one-line headline that needs two lines is refused");
});

test("render: bytes that no longer match the reviewed hash are refused; a wrong template version is refused", async () => {
  const { facts, bytes } = await syntheticSources();
  const t = T("lucas-real-work-gbp");
  const tampered = async (a) => (a.id === P.a2 ? new Uint8Array([...bytes.get(a.content_hash), 0]) : bytes.get(a.content_hash));
  assert.equal(await refusal(async () => render(await nodeEngine(), t, facts, await requestFor(t), tampered)), "source_hash_mismatch");
  const req = await requestFor(t);
  req.template.spec_hash = "sha256:" + "0".repeat(64);
  assert.equal(await refusal(async () => render(await nodeEngine(), t, facts, req, async (a) => bytes.get(a.content_hash))), "template_version_mismatch");
  const other = await requestFor(t);
  other.template.version = 2;
  assert.equal(await refusal(async () => render(await nodeEngine(), t, facts, other, async (a) => bytes.get(a.content_hash))), "template_mismatch");
});

test("contrast helper matches WCAG", () => {
  assert.ok(Math.abs(contrast("#ffffff", "#000000") - 21) < 1e-9);
  assert.ok(contrast("#72d2e4", "#0d0f10") > 11);
});
