// The Social Style Analyzer (SH2): supabase/functions/social-history/
// analyze.ts, style-input.ts and the handler's `analyze` mode, over
// fictional history. The database rules for profiles (who records, who
// approves, one proposed / one approved, content immutable, examples only
// from the learnable view) are tested on the real schema by the sandbox's
// social_history_style.test.sql.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, ANALYZER_VERSION, factSpans, fingerprintSource, maskText, MIN_PERFORMANCE_AGE_HOURS, placeBook } from "../supabase/functions/social-history/analyze.ts";
import { buildStyleInput, exclusionOf, fingerprint } from "../supabase/functions/social-history/style-input.ts";
import { createSocialHistory } from "../supabase/functions/social-history/handler.ts";
import { stableJson } from "../supabase/functions/post-drafter/rules.ts";

const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const MEMBER = "00000000-0000-4000-8000-00000000aa02";
const AS_OF = "2026-10-08T01:00:00.000Z";
const day = (n) => new Date(Date.parse("2026-10-01T17:00:00Z") - n * 86_400_000).toISOString();
const SIG = "\n\n📞 (555) 010-0199\n🌐 fictional-roofing.example\n\n#FictionalRoofing #FictionvilleMO #RoofRepair #LocalRoofers #OtherburgMO";
const VOICE = [
  "🏠 Your roof is your home's first line of defense.\n\nAt Fictional Roofing, we help homeowners in Fictionville protect what matters with honest inspections and careful repairs.\n\n✔️ Roof Repairs\n✔️ Roof Replacements\n✔️ Gutters" + SIG,
  "🏠 Built to Last. Backed by Neighbors.\n\nWhen it comes to protecting your home, care and clear communication matter. Our local team is here to help with roof repairs and replacements.\n\n✔️ Roof Repairs\n✔️ Siding & Gutters\n✔️ Inspections" + SIG,
  "⚠️ Missing shingles or loose flashing are signs your roof may need attention.\n\nIf you notice a leak after a storm, give us a call and we'll take a look.\n\n✔️ Inspections\n✔️ Roof Repairs\n✔️ Gutters" + SIG,
  "🏠 Protect Your Home with Roofing You Can Trust.\n\nYour roof works hard every day. Our crew takes the time to explain what we see and what it needs.\n\n✔️ Roof Repairs\n✔️ Roof Replacements\n✔️ Siding" + SIG,
];
function post(n, o = {}) {
  const copy = o.copy ?? VOICE[n % VOICE.length] + ` (${n})`;
  const reach = o.reach === undefined ? 400 + (n % 5) * 20 : o.reach;
  const reactions = o.reactions ?? Math.round((reach ?? 400) * 0.03);
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    platform: "facebook",
    platform_post_id: `100200300400500_${9000 + n}`,
    published_at: o.published_at ?? day(n * 3),
    copy,
    copy_hash: `h${n}`.padEnd(64, "0"),
    format: o.format ?? (n % 2 ? "reel" : "photo"),
    permalink: `https://www.facebook.com/100200300400500/posts/${9000 + n}`,
    media: [{ type: "image" }],
    origin: o.origin ?? "external",
    learning_status: o.learning_status ?? "included",
    learning_note: o.learning_note ?? null,
    is_paid: o.is_paid ?? false,
    is_owner: o.is_owner ?? true,
    missing_since: null,
    metrics_captured_at: o.no_metrics ? null : AS_OF,
    metrics_age_hours: o.age_hours ?? (Date.parse(AS_OF) - Date.parse(o.published_at ?? day(n * 3))) / 3_600_000,
    impressions: reach == null ? null : reach + 50,
    reach,
    reactions,
    comments: o.comments ?? 1,
    shares: o.shares ?? 1,
    clicks: 4,
    views: 0,
    metrics_unavailable: reach == null ? ["impressions", "reach", "saves"] : ["saves"],
  };
}
const INTEL = {
  client: { id: CLIENT, name: "Fictional Roofing", phone: "(555) 010-0199", website_url: "https://fictional-roofing.example", city: "Fictionville", state: "MO",
    service_area: "Fictionville, Otherburg, Sample County, and Example County, Missouri", business_type: null, address_line1: null },
  brand: { words_we_avoid: ["storm chaser", "cheapest", "high-pressure language"] },
  board: { hard_rules: ["Never quote or imply pricing."] },
  claims: [
    { id: "c1", claim: "Lifetime Workmanship Warranty", status: "sourced", source: "https://fictional-roofing.example/warranty" },
    { id: "c2", claim: "Family-operated since 2018", status: "unverified", source: null },
  ],
  locations: [{ name: "Fictionville", city: "Fictionville", state: "MO", is_active: true }, { name: "Old", city: "Oldtown", state: "MO", is_active: false }],
};
function rows() {
  const r = [];
  for (let n = 1; n <= 20; n++) r.push(post(n));
  r.push(post(21, { copy: "🚪💰 Fictional Roofing is hiring Door Knockers! $15/hour + bonuses. Tag someone who'd be great!" }));
  r.push(post(22, { copy: "" }));
  r.push(post(23, { copy: "Early bird discount for all installs before October 15th. Call now!" }));
  r.push(post(24, { copy: "Holiday lights are back! Get on the schedule before our limited spots fill up. Free design consultation." + SIG }));
  r.push(post(25, { copy: VOICE[0] + " viral", reach: 9000, reactions: 900, shares: 60 }));            // outlier
  r.push(post(26, { copy: VOICE[1] + " compass", origin: "compass" }));                              // never learnable
  r.push(post(27, { copy: VOICE[2] + " paid", is_paid: true, reach: 5000 }));
  r.push(post(28, { copy: VOICE[3] + " fresh", published_at: "2026-10-05T17:00:00.000Z" }));           // too young for performance
  r.push(post(29, { copy: VOICE[0] + " no reach", reach: null }));
  r.push(post(30, { copy: VOICE[1] + " strong", reactions: 30, shares: 6, published_at: day(1) }));     // high lift
  r.push(post(31, { copy: VOICE[2] + " strong too", reactions: 30, shares: 6, published_at: day(2) })); // high lift, same week
  return r;
}
const learnableOf = (rs) => new Set(rs.filter((r) => r.origin !== "compass" && !r.is_paid && r.learning_status === "included").map((r) => r.id));
const input = (rs = rows()) => buildStyleInput(INTEL, rs, learnableOf(rs));

test("the analysis is deterministic: same rows (in any order) give the same profile and fingerprint", async () => {
  const a = analyze(input());
  const shuffled = rows().reverse();
  const b = analyze(buildStyleInput(INTEL, shuffled, learnableOf(shuffled)));
  assert.equal(stableJson(a), stableJson(b));
  assert.equal(await fingerprint(input()), await fingerprint(buildStyleInput(INTEL, shuffled, learnableOf(shuffled))));
  assert.match(await fingerprint(input()), /^[0-9a-f]{64}$/);
  assert.equal(a.analyzer_version, ANALYZER_VERSION);
  assert.equal(a.as_of, AS_OF, "as of the newest data, never the clock");
  assert.match(a.boundary, /Never factual grounding/);
});

test("excluding a post changes the fingerprint (a new analysis is a new version)", async () => {
  const rs = rows();
  const before = await fingerprint(buildStyleInput(INTEL, rs, learnableOf(rs)));
  rs[0].learning_status = "excluded"; rs[0].learning_note = "Old offer";
  assert.notEqual(await fingerprint(buildStyleInput(INTEL, rs, learnableOf(rs))), before);
});

test("Compass-generated and paid posts never reach the voice, the examples or the baseline", () => {
  const p = analyze(input());
  const compass = post(26, { origin: "compass" }).id;
  const paid = post(27, { is_paid: true }).id;
  const examples = [...p.representative, ...p.top_performers, ...p.outliers].map((e) => e.post_id);
  assert.ok(!examples.includes(compass) && !examples.includes(paid));
  const dnl = Object.fromEntries(p.do_not_learn.posts.map((d) => [d.post_id, d.reasons]));
  assert.match(dnl[compass][0].detail, /Compass-generated/);
  assert.match(dnl[paid][0].detail, /Paid/);
  assert.equal(p.corpus.learnable, p.corpus.imported - 2);
  assert.equal(p.traits.engagement.eligible_posts, p.corpus.performance_eligible);
});

test("do-not-learn: hiring, no caption, one-off promotion, scarcity wording; each with a reason", () => {
  const p = analyze(input());
  const codes = Object.fromEntries(p.do_not_learn.posts.map((d) => [d.post_id, d.reasons.map((r) => r.code)]));
  assert.ok(codes[post(21).id].includes("hiring"));
  assert.ok(codes[post(22).id].includes("no_caption"));
  assert.ok(codes[post(23).id].includes("one_off_promotion"));
  assert.ok(codes[post(24).id].includes("conflicts_with_brand_rules"));
  for (const d of p.do_not_learn.posts) for (const r of d.reasons) assert.ok(r.detail.length > 10);
});

test("unavailable reach gives no engagement rate, never a computed one, and leaves the post out of performance", () => {
  const p = analyze(input());
  const noReach = post(29, { reach: null }).id;
  const ex = [...p.representative, ...p.top_performers].find((e) => e.post_id === noReach);
  if (ex) assert.equal(ex.metrics.engagement_per_reach, null);
  const allNull = rows().map((r) => ({ ...r, reach: null, impressions: null }));
  const q = analyze(buildStyleInput(INTEL, allNull, learnableOf(allNull)));
  assert.equal(q.traits.engagement.eligible_posts, 0);
  assert.equal(q.traits.engagement.baseline.overall, null);
  assert.equal(q.traits.engagement.confidence, "low");
  assert.deepEqual(q.top_performers, []);
  assert.deepEqual(q.outliers, []);
  assert.equal(q.metric_availability.reach.present, 0);
});

test("performance is relative to the client's own baseline; young posts wait; outliers inform but never define the voice", () => {
  const p = analyze(input());
  const young = post(28, { published_at: "2026-10-05T17:00:00.000Z" });
  assert.ok(young.metrics_age_hours < MIN_PERFORMANCE_AGE_HOURS);
  assert.ok(!p.top_performers.some((e) => e.post_id === young.id));
  const viral = post(25).id;
  assert.deepEqual(p.outliers.map((o) => o.post_id), [viral]);
  assert.ok(!p.representative.some((e) => e.post_id === viral) && !p.top_performers.some((e) => e.post_id === viral));
  assert.ok(p.traits.engagement.baseline.overall > 0);
  for (const t of p.top_performers) assert.ok(t.metrics.lift >= 1.25);
  // Two strong posts a day apart: only one is kept (one per week).
  const strong = [post(30).id, post(31).id].filter((id) => p.top_performers.some((e) => e.post_id === id));
  assert.equal(strong.length, 1);
  assert.match(p.traits.engagement.basis, /no generic benchmark/);
  assert.equal(p.traits.engagement.confidence === "high", false, "one snapshot caps performance at medium");
});

test("representative posts are learnable voice posts and every example is masked by the client's rules", () => {
  const p = analyze(input());
  assert.ok(p.representative.length >= 2);
  const learnable = learnableOf(rows());
  for (const e of [...p.representative, ...p.top_performers]) {
    assert.ok(learnable.has(e.post_id));
    assert.ok(!/OtherburgMO/i.test(e.masked_copy), "an unapproved place hashtag is masked");
    assert.match(e.masked_copy, /\(555\) 010-0199/, "the client's own phone is kept");
    assert.match(e.masked_copy, /Fictionville/, "an approved place is kept");
  }
  for (const k of Object.keys(p.traits)) assert.ok(["high", "medium", "low"].includes(p.traits[k].confidence), k);
});

test("masking: unsupported facts, prices, urgency and unapproved places are masked; a usable claim's exact words are not", () => {
  const inp = input();
  const book = placeBook(inp);
  const text = "Free estimates! 100+ 5-star reviews, Lifetime Workmanship Warranty, serving Otherburg and Sample County. Call now — limited spots. Call (555) 010-0199.";
  const masked = maskText(text, factSpans(text, inp, book));
  assert.match(masked, /\[price\/offer\]/);
  assert.match(masked, /\[review\]/);
  assert.match(masked, /\[urgency\]/);
  assert.match(masked, /\[place not approved\]/);
  assert.match(masked, /Lifetime Workmanship Warranty/);
  assert.match(masked, /\(555\) 010-0199/);
  assert.doesNotMatch(masked, /Otherburg|Sample County|100\+/);
});

test("the input: approved places are active locations only; usable claims only; exclusions say why", () => {
  const inp = input();
  assert.deepEqual(inp.places.approved, ["Fictionville, MO"]);
  assert.deepEqual(inp.usable_claims, ["Lifetime Workmanship Warranty"]);
  assert.equal(exclusionOf(post(1), true), null);
  assert.match(exclusionOf(post(2, { learning_status: "excluded", learning_note: "Outdated" }), false), /teammate: Outdated/);
  assert.match(exclusionOf(post(3), false), /Matches a Compass post/);
  assert.ok(fingerprintSource(inp).includes(ANALYZER_VERSION));
});

// ── The handler's analyze mode ──────────────────────────────────────────────
function styleStore(o = {}) {
  const s = { recorded: [], rows: o.rows ?? rows() };
  return {
    s,
    async secret(name) { return { SYNC_CRON_SECRET: "cron-secret" }[name] ?? null; },
    async caller(jwt) { return { "jwt-member": { member: MEMBER, role: "member" } }[jwt] ?? "none"; },
    async client(id) { return id === CLIENT ? { id: CLIENT, name: "Fictional Roofing", status: "active" } : null; },
    async intelligence() { return INTEL; },
    async history() { return s.rows; },
    async learnable() { return learnableOf(s.rows); },
    async recordProfile(clientId, platform, fp, profile, requestedBy) {
      const same = s.recorded.find((r) => r.fp === fp);
      if (same) return { id: same.id, version: same.version, status: "proposed", profile_hash: "f".repeat(64), unchanged: true };
      const r = { id: `prof-${s.recorded.length + 1}`, version: s.recorded.length + 1, fp, profile, requestedBy, platform };
      s.recorded.push(r);
      return { id: r.id, version: r.version, status: "proposed", profile_hash: "e".repeat(64), unchanged: false, superseded: null };
    },
  };
}
const call = (h, body, headers = { Authorization: "Bearer jwt-member" }) =>
  h.handle(new Request("https://x/social-history", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

test("analyze dry_run returns the proposed profile and writes nothing", async () => {
  const store = styleStore();
  const h = createSocialHistory({ store, fetch: () => { throw new Error("no network"); } });
  const res = await call(h, { mode: "analyze", client_id: CLIENT, dry_run: true });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.writes, "none");
  assert.equal(j.profile.schema, "compass-social-style/1");
  assert.equal(store.s.recorded.length, 0);
});

test("analyze records a PROPOSED profile for the teammate; the same data again is unchanged; the operator door records no teammate", async () => {
  const store = styleStore();
  const h = createSocialHistory({ store, fetch: () => { throw new Error("no network"); } });
  const first = await call(h, { mode: "analyze", client_id: CLIENT });
  assert.equal(first.status, 201);
  const j = await first.json();
  assert.equal(j.status, "proposed");
  assert.equal(store.s.recorded[0].requestedBy, MEMBER);
  assert.match(j.fingerprint, /^[0-9a-f]{64}$/);
  const again = await call(h, { mode: "analyze", client_id: CLIENT });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).unchanged, true);
  store.s.rows = store.s.rows.slice(1);
  const worker = await call(h, { mode: "analyze", client_id: CLIENT }, { "x-cron-secret": "cron-secret" });
  assert.equal(worker.status, 201);
  assert.equal(store.s.recorded[1].requestedBy, null);
});

test("analyze refuses without history, with unknown fields and for another platform; it never calls Zernio", async () => {
  let fetched = 0;
  const h = createSocialHistory({ store: styleStore({ rows: [] }), fetch: () => { fetched++; throw new Error("no"); } });
  assert.equal((await call(h, { mode: "analyze", client_id: CLIENT })).status, 409);
  assert.equal((await call(h, { mode: "analyze", client_id: CLIENT, limit: 5 })).status, 400);
  assert.equal((await call(h, { mode: "analyze", client_id: CLIENT, platform: "instagram" })).status, 400);
  assert.equal((await call(h, { mode: "analyze", client_id: CLIENT, dry_run: "yes" })).status, 400);
  assert.equal((await call(h, { mode: "analyze", client_id: CLIENT }, {})).status, 401);
  assert.equal(fetched, 0);
});

// ── The Social › Style page's view model (src/lib/social-style.ts) ──────────
test("the page reads every trait of a real analysis with its confidence; reviews and answers say what happened", async () => {
  const { traitViews, readProfile, validateStyleReview, analyzeMessage } = await import("../src/lib/social-style.ts");
  const p = analyze(input());
  const views = traitViews(p);
  assert.deepEqual(views.map((t) => t.key), ["caption_length", "structure", "openings", "sentences", "tone", "emoji", "hashtags", "cta",
    "locations", "content_mix", "media_mix", "cadence", "recurring_language", "engagement"]);
  for (const t of views) {
    assert.ok(["high", "medium", "low"].includes(t.confidence));
    assert.ok(t.lines.length > 0 && t.lines.every((l) => typeof l === "string" && !l.includes("undefined") && !l.includes("[object")), t.key);
  }
  const r = readProfile(p);
  assert.equal(r.representative.length, p.representative.length);
  assert.ok(r.doNotLearnPosts.length > 0 && r.doNotLearnPhrases.length > 0);
  assert.deepEqual(readProfile(null).representative, []);
  assert.equal(validateStyleReview("reject", "  ").ok, false);
  assert.deepEqual(validateStyleReview("approve", ""), { ok: true, decision: "approve", note: null });
  assert.equal(validateStyleReview("publish", "x").ok, false);
  assert.match(analyzeMessage(201, { version: 2 }).text, /proposed version 2/);
  assert.match(analyzeMessage(200, { version: 2 }).text, /Nothing changed/);
  assert.equal(analyzeMessage(409, { message: "Import the client's history first" }).ok, false);
  assert.equal(analyzeMessage(null, null).ok, false);
});
