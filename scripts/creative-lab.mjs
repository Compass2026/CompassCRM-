#!/usr/bin/env node
// Creative Lab (Preview Mode, Oct 8 2026; docs/creative-lab.md).
//
// Renders a sprint of concepts — strategy, Facebook and Business Profile copy,
// and creative — into a local preview gallery. It writes nothing to the
// database, Storage, Zernio or Google: nothing is created, approved,
// scheduled or published. Promotion is a separate, human step through the AI
// Drafter and the post review gate.
//
//   node --no-warnings scripts/creative-lab.mjs --sprint lab/lucas/sprint-01.json \
//     --sources <dir of source files> --out <dir> [--only c3]
//
// What Preview Mode relaxes: no template registration or client approval, no
// approved Social Style Profile (the proposed one is a soft signal), no review
// of a concept, a variation or a regeneration.
// What it never relaxes — every concept is checked exactly as a draft would be:
//   copy   the AI Drafter's own brief (buildBrief: approved service, live
//          target page, usable claims, approved places, brand rules) and its
//          linter (lintDraft), plus the client's creative kit phrases.
//          Facebook copy takes the same factual rules; only the Business
//          Profile channel limits (length, hashtags, links) are not applied.
//   image  the Creative Engine's render(): every word a governed role, every
//          photo an approved own-work file re-hashed against its reviewed
//          hash, never enlarged; a claim the Drafter excludes is refused here
//          too.
// Source files come from the creative-lab function's `sources` mode (signed,
// five-minute links); any file whose bytes do not match a reviewed hash is
// ignored.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { nodeEngine } from "./lib/creative-engine-node.mjs";
import { labTemplate } from "./lib/creative-lab-layouts.mjs";
import { render } from "../supabase/functions/creative-engine/render.ts";
import { specHash } from "../supabase/functions/creative-engine/spec.ts";
import { KITS } from "../supabase/functions/creative-engine/kits.ts";
import { buildBrief, briefHash } from "../supabase/functions/post-drafter/brief.ts";
import { lintDraft } from "../supabase/functions/post-drafter/lint.ts";

const args = process.argv.slice(2);
const arg = (name, dflt = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const die = (m) => { console.error(m); process.exit(2); };
const root = new URL("../", import.meta.url);
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const sprintPath = arg("sprint") ?? die("--sprint <sprint.json> is required");
const sprint = readJson(sprintPath);
const outDir = arg("out") ?? die("--out <dir> is required");
const sourcesDir = arg("sources") ?? die("--sources <dir> is required (files from creative-lab sources)");
const only = arg("only");
fs.mkdirSync(outDir, { recursive: true });

const base = path.dirname(sprintPath);
const facts = readJson(path.resolve(base, sprint.facts));
let input = readJson(path.resolve(base, sprint.intelligence));
if (input.input) input = input.input;
const kit = KITS[sprint.kit];
if (!kit || kit.client_id !== facts.client.id || input.client.id !== facts.client.id) die("kit, facts and intelligence must be the same client");

// Source bytes by content hash; only files matching a reviewed hash count.
const reviewed = new Set(facts.assets.map((a) => a.content_hash).filter(Boolean));
const bytes = new Map();
for (const f of fs.readdirSync(sourcesDir)) {
  const b = new Uint8Array(fs.readFileSync(path.join(sourcesDir, f)));
  const h = crypto.createHash("sha256").update(b).digest("hex");
  if (reviewed.has(h)) bytes.set(h, b);
}

const cities = readJson(new URL("src/data/us-cities.json", root));
const gazetteer = [...new Set(cities.filter((c) => c[1] === input.client.state).map((c) => c[0]))];
const FB_RULES = { min_chars: 40, preferred_min_chars: 250, preferred_max_chars: 1200, max_chars: 2200, hard_max_chars: 63206, lead_chars: 125,
  hashtags: true, urls_in_body: true, keyword_max_exact_uses: 1 };
const FB_SKIP = new Set(["hashtag", "url_in_body"]);

function kitPhrases(copy) {
  return kit.blocked_phrases.filter((src) => new RegExp(src, "i").test(copy))
    .map((src) => ({ code: "kit_phrase", message: `The client's creative kit rules out /${src}/ (pending confirmation or approval).`, match: src }));
}

function lintCopy(brief, channel, draft) {
  if (!draft?.copy) return null;
  const b = channel === "facebook" ? { ...brief, target: { ...brief.target, channel: "google_business" }, channel_rules: FB_RULES } : brief;
  const r = lintDraft(b, { copy: draft.copy, claim_ids: draft.claim_ids ?? [] }, { gazetteer });
  const problems = [...r.problems.filter((p) => channel !== "facebook" || !(FB_SKIP.has(p.code) || p.code.startsWith("channel_"))), ...kitPhrases(draft.copy)];
  return { ok: problems.length === 0, characters: draft.copy.trim().length, problems, warnings: r.warnings };
}

const engine = await nodeEngine();
async function renderCreative(c, brief, file) {
  const t = labTemplate(c.template, sprint.kit);
  if (!t) return { ok: false, code: "template_unknown", message: `No layout ${c.template}` };
  const excluded = new Map((brief?.excluded?.claims ?? []).map((x) => [x.id, x.reason]));
  const claimRefs = Object.values(c.bindings ?? {}).flat().filter((b) => b.role === "claim").map((b) => b.source_id);
  for (const id of claimRefs) {
    if (excluded.has(id)) return { ok: false, code: "claim_excluded", message: `The Drafter excludes this claim: ${excluded.get(id)}` };
  }
  try {
    const r = await render(engine, t, facts,
      { template: { key: t.key, version: t.version, spec_hash: await specHash(t.spec) }, client_id: facts.client.id,
        service_id: c.service_id ?? null, bindings: c.bindings ?? {}, photos: c.photos ?? {} },
      async (a) => { const b = bytes.get(a.content_hash); if (!b) throw Object.assign(new Error(`source ${a.id} not downloaded`), { code: "source_missing" }); return b; });
    fs.writeFileSync(path.join(outDir, file), r.png);
    return { ok: true, file, template: t.key, width: r.width, height: r.height, content_hash: r.content_hash, copy_hash: r.copy_hash,
      overlay: r.overlay, sources: r.sources.map((s) => ({ id: s.brand_asset_id, role: s.role })), alt_text: r.alt_text };
  } catch (e) {
    return { ok: false, code: e.code ?? "error", message: e.message };
  }
}

const results = [];
for (const c of sprint.concepts) {
  if (only && c.id !== only) continue;
  const s = c.strategy;
  const service = input.services.find((x) => x.name === s.service);
  const keyword = s.keyword ? input.keywords.find((k) => k.keyword.toLowerCase() === s.keyword.toLowerCase()) : null;
  const built = buildBrief(input, { channel: "google_business", postType: "standard", intent: s.intent, serviceId: service?.id ?? null,
    keywordId: keyword?.id ?? null, ctaType: c.gbp?.cta ?? "LEARN_MORE", offerId: null, assetIds: [] });
  const brief = built.ok ? built.brief : null;
  const out = { id: c.id, title: c.title, strategy: s, why: c.why, brief: built.ok
    ? { ok: true, hash: await briefHash(brief), cta: brief.target.cta, places: brief.allowed_facts.crm.places,
        claims: brief.allowed_facts.claims.map((x) => ({ id: x.id, text: x.text })) }
    : { ok: false, refusals: built.refusals } };
  for (const ch of ["facebook", "gbp"]) {
    const d = c[ch];
    if (!d) continue;
    out[ch] = {
      copy: d.copy, claim_ids: d.claim_ids ?? [], cta: ch === "gbp" ? brief?.target.cta ?? null : d.cta ?? null,
      lint: brief ? lintCopy(brief, ch, d) : { ok: false, problems: built.refusals },
      creative: d.creative ? await renderCreative(d.creative, brief, `${c.id}-${ch}.png`) : null,
      treatment: d.creative?.why ?? null,
    };
  }
  results.push(out);
  const flag = (x) => (x ? (x.ok ? "ok" : "FAIL") : "-");
  console.log(`${c.id}  brief ${flag(out.brief)}  fb copy ${flag(out.facebook?.lint)} image ${flag(out.facebook?.creative)}  gbp copy ${flag(out.gbp?.lint)} image ${flag(out.gbp?.creative)}`);
  for (const ch of ["facebook", "gbp"]) {
    for (const p of out[ch]?.lint?.problems ?? []) console.log(`   ${ch} copy: ${p.code} ${p.match ?? ""} — ${p.message}`);
    if (out[ch]?.creative && !out[ch].creative.ok) console.log(`   ${ch} image: ${out[ch].creative.code} — ${out[ch].creative.message}`);
  }
}
const prior = fs.existsSync(path.join(outDir, "results.json")) && only ? readJson(path.join(outDir, "results.json")) : null;
const merged = prior ? { ...prior, concepts: prior.concepts.map((x) => results.find((r) => r.id === x.id) ?? x) } : null;
fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(merged ?? {
  sprint: sprint.title, client: facts.client.name, generated_at: new Date().toISOString(), writes: false,
  style_profile: sprint.style_profile ?? null, market_signals: sprint.market_signals ?? null, concepts: results,
}, null, 2));
console.log(`\n${results.length} concept(s) → ${outDir}`);
