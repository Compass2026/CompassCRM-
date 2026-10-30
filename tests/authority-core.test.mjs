// Authority v1.5 (P1.3): opportunity discovery limited to each site's
// approved Core 50. Pure: the Lucas-shaped engine fixture with an
// authority.core scope shaped like authority_core_scope() (the database side
// is tests/authority-core-database.test.mjs). Fictional and trimmed data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAuthority } from "../supabase/functions/authority/engine.ts";
import { coreVerdict } from "../supabase/functions/authority/core.ts";
import { lucasAuthority, ROOF, REPAIR, STORM, KW } from "./fixtures/authority-lucas.mjs";
import { approvedCore, CORE_LIST } from "./fixtures/authority-core.mjs";

const posts = (r) => r.opportunities.filter((o) => o.key.startsWith("gbp_post:"));
const ready = (r) => r.opportunities.filter((o) => o.section === "ready");
const byKey = (r, k) => r.opportunities.find((o) => o.key === k);
const gate = (o, g) => o.gates.find((x) => x.gate === g);
const scoped = (fn) => { const i = lucasAuthority(); fn?.(i); return i; };
const PROPOSAL = { id: "c0re0000-0000-4000-8000-000000000001", version: 1, proposed_at: "2026-10-20T12:00:00Z", count: 50 };

// A wider inventory: 60 off-list Roof Replacement keywords that outrank the
// list on every signal (p1, money, tracked, volume).
function wider(i) {
  for (let n = 1; n <= 60; n++) {
    i.keywords.push({ id: `kw-off-${n}`, keyword: `roof replacement wentzville option ${n}`, intent: ["commercial", "informational", "transactional"][n % 3],
      intent_note: null, is_active: true, is_tracked: true, is_money: true, service_id: ROOF, target_url: i.services[0].page_url, priority: "p1" });
    i.authority.keywordExtras.push({ id: `kw-off-${n}`, volume: 5000, cpc: 40, city: "Wentzville" });
  }
}

test("single site: only the approved list's keywords become Ready, however the wider inventory ranks", () => {
  const i = scoped((x) => { const list = approvedCore(x).programs[0].list.keyword_ids; wider(x); x.authority.core = approvedCore(x, { include: list }); });
  assert.equal(i.authority.core.off_list, 60 + 2);   // the 60 plus christmas lights and metal roofing
  const r = runAuthority(i);
  assert.deepEqual(ready(r).map((o) => o.target.keyword).sort(), ["how long does a roof last", "new roof installation wentzville", "roof replacement wentzville"]);
  assert.ok(!r.opportunities.some((o) => o.target.keyword_id?.startsWith("kw-off-")), "an off-list keyword is never a target");
  assert.equal(r.keywords.find((k) => k.keyword_id === "kw-off-1").core.status, "off_list");
  assert.equal(r.keywords.find((k) => k.keyword_id === KW).core.status, "core");
});

test("an intent with no usable core keyword is blocked with the reason, never filled from the inventory", () => {
  const r = runAuthority(scoped((x) => { x.authority.core = approvedCore(x, { exclude: ["kw-info"] }); }));
  const info = byKey(r, `gbp_post:${ROOF}:informational`);
  assert.equal(info.section, "blocked");
  assert.equal(info.action, "blocked_data_prerequisite");
  assert.equal(info.target.keyword_id, "kw-info");
  assert.equal(info.core.verdict, "keyword_not_core");
  assert.equal(gate(info, "core_keyword").pass, false);
  assert.match(gate(info, "drafter_brief").detail, /Not attempted/);
  assert.equal(info.tier, "none");
});

test("a retired keyword the list still names is not in scope", () => {
  const r = runAuthority(scoped((x) => {
    const ids = approvedCore(x).programs[0].list.keyword_ids;
    x.keywords.find((k) => k.id === "kw-trans").is_active = false;
    x.authority.core = approvedCore(x, { include: ids });
  }));
  const t = byKey(r, `gbp_post:${ROOF}:transactional`);
  assert.equal(t.target.keyword_id, "kw-trans");
  assert.equal(t.core.verdict, "keyword_not_core");
  assert.equal(t.section, "blocked");
});

test("a supporting child counts only through an approved core parent, and says so", () => {
  const child = { id: "kw-child", keyword: "tear off roof replacement wentzville", intent: "transactional", intent_note: null, is_active: true,
    is_tracked: true, is_money: true, service_id: ROOF, target_url: lucasAuthority().services[0].page_url, priority: "p1" };
  const list = approvedCore(lucasAuthority()).programs[0].list.keyword_ids;
  const withParent = runAuthority(scoped((x) => { x.keywords.push(child); x.authority.core = approvedCore(x, { include: list, children: { "kw-child": KW } }); }));
  const t = byKey(withParent, `gbp_post:${ROOF}:transactional`);
  assert.equal(t.target.keyword_id, "kw-child");
  assert.equal(t.section, "ready");
  assert.deepEqual([t.core.relation, t.core.core_keyword_id, t.core.list_id, t.core.list_version], ["child", KW, CORE_LIST, 2]);
  const orphan = runAuthority(scoped((x) => { x.keywords.push(child); x.authority.core = approvedCore(x, { include: list }); }));
  const o = byKey(orphan, `gbp_post:${ROOF}:transactional`);
  assert.equal(o.target.keyword_id, "kw-trans", "without a core parent the child is ignored; the core keyword is used");
});

test("proposed only (Ginger shaped): nothing Ready, one decision naming the proposal, no fallback", () => {
  const r = runAuthority(scoped((x) => { x.authority.core = approvedCore(x, { status: "proposed_only", proposal: PROPOSAL }); }));
  assert.equal(ready(r).length, 0);
  assert.ok(posts(r).length > 0);
  for (const o of posts(r)) {
    assert.equal(o.core.verdict, "core_list_not_approved");
    assert.equal(o.action, "blocked_data_prerequisite");
  }
  const d = byKey(r, "core_list:client");
  assert.equal(d.action, "requires_confirmation");
  assert.equal(d.section, "needs_decision");
  assert.match(d.gap, /v1 \(50 keywords\) is proposed, not approved/);
  assert.match(d.blockers[0], /the other keywords are not used instead/);
  assert.equal(byKey(r, `service_page:${STORM}`).action, "blocked_data_prerequisite");
  for (const c of r.campaigns) assert.ok(c.blockers.some((b) => /Core 50 is not usable: core_list_not_approved/.test(b)), c.name);
  assert.ok(r.campaigns.every((c) => c.cluster.length === 0 && c.channels.every((ch) => ch.status === "blocked")));
  assert.equal(r.core.programs[0].status, "proposed_only");
  assert.deepEqual(r.core.programs[0].keyword_ids, []);
});

test("no list at all, and no scope at all: blocked, explicit, nothing Ready", () => {
  const none = runAuthority(scoped((x) => { x.authority.core = approvedCore(x, { status: "missing" }); }));
  assert.equal(ready(none).length, 0);
  assert.ok(posts(none).every((o) => o.core.verdict === "core_list_missing"));
  assert.match(byKey(none, "core_list:client").gap, /has no Core 50 list/);

  for (const core of [undefined, null, { schema: "something-else" }]) {
    const r = runAuthority(scoped((x) => { x.authority.core = core; }));
    assert.equal(ready(r).length, 0);
    assert.ok(posts(r).every((o) => o.core.verdict === "core_scope_missing"));
    assert.equal(byKey(r, "core_list:scope").action, "blocked_data_prerequisite");
    assert.equal(r.core.loaded, false);
    assert.ok(r.keywords.every((k) => k.core.status === "not_loaded"));
    // No keyword-targeted content opportunity is actionable.
    assert.ok(!r.opportunities.some((o) => ["gbp_post", "service_page", "blog_post"].includes(o.content_type) && o.action === "create" && o.target.keyword_id));
  }
});

test("another client's scope is never read as this client's", () => {
  const r = runAuthority(scoped((x) => { x.authority.core = { ...approvedCore(x), client_id: "00000000-0000-4000-8000-00000000dead" }; }));
  assert.equal(ready(r).length, 0);
  assert.ok(posts(r).every((o) => o.core.verdict === "core_scope_missing"));
  assert.ok(byKey(r, "core_list:scope"), "read as no scope at all");
  assert.equal(r.core.loaded, false);
});

// Three brand sites over the same services: Roof Replacement on S1 (approved),
// Roof Repair on S2 (a 46-keyword proposal), Storm Damage on S3 (28).
function threeSites(x, { s1 = "approved" } = {}) {
  const base = approvedCore(x, { include: approvedCore(x).programs[0].list.keyword_ids.filter((id) => x.keywords.find((k) => k.id === id)?.service_id === ROOF) });
  const prog = (n, status, services, count) => ({ program_id: `site-${n}`, name: `Site ${n}`, website_url: `https://s${n}.example.test`, service_ids: services,
    status, list: status === "approved" ? { ...base.programs[0].list, id: `list-s${n}` } : null,
    proposal: status === "approved" ? null : { ...PROPOSAL, id: `prop-s${n}`, count } });
  return { ...base, multi: true,
    programs: [prog(1, s1, [ROOF], 49), prog(2, "proposed_only", [REPAIR], 46), prog(3, "proposed_only", [STORM], 28)],
    keywords: s1 === "approved" ? base.keywords.map((k) => ({ ...k, program_id: "site-1", list_id: "list-s1" })) : [] };
}

test("three brand sites: each site's own list only; proposals on two sites block only those sites", () => {
  const r = runAuthority(scoped((x) => { x.authority.core = threeSites(x); }));
  assert.ok(ready(r).length > 0);
  assert.ok(ready(r).every((o) => o.service_id === ROOF && o.core.program_id === "site-1" && o.core.list_id === "list-s1"));
  for (const o of r.opportunities.filter((o) => o.core && o.service_id !== ROOF)) assert.equal(o.core.verdict, "core_list_not_approved", o.key);
  assert.deepEqual(r.opportunities.filter((o) => o.key.startsWith("core_list:")).map((o) => [o.key, o.gap]), [
    ["core_list:site-2", "Site 2's Core 50 v1 (46 keywords) is proposed, not approved."],
    ["core_list:site-3", "Site 3's Core 50 v1 (28 keywords) is proposed, not approved."],
  ]);
  assert.deepEqual(r.core.programs.map((p) => [p.program_id, p.status, p.keyword_ids.length]), [["site-1", "approved", 9], ["site-2", "proposed_only", 0], ["site-3", "proposed_only", 0]]);

  const none = runAuthority(scoped((x) => { x.authority.core = threeSites(x, { s1: "proposed_only" }); }));
  assert.equal(ready(none).length, 0, "49 / 46 / 28 proposals: nothing passes");
  assert.equal(none.opportunities.filter((o) => o.key.startsWith("core_list:")).length, 3);
});

test("three brand sites: a keyword of one site never qualifies another site's service", () => {
  const i = scoped((x) => { x.authority.core = threeSites(x, { s1: "approved" }); });
  i.authority.core.programs[1] = { ...i.authority.core.programs[1], status: "approved", list: { id: "list-s2", version: 1, approved_at: "2026-10-30T00:00:00Z", keyword_ids: ["kw-repair"] }, proposal: null };
  assert.equal(coreVerdict(i, KW, ROOF, "post").ok, true);
  assert.equal(coreVerdict(i, KW, REPAIR, "post").receipt.verdict, "keyword_wrong_program", "Site 1's keyword for Site 2's service");
  assert.equal(coreVerdict(i, "kw-repair", REPAIR, "post").receipt.verdict, "keyword_not_core", "Site 2's list names it, but its scope row is not there: never inferred");
  assert.equal(coreVerdict(i, KW, "svc-on-no-site", "post").receipt.verdict, "program_unresolved");
  assert.equal(coreVerdict(i, KW, null, "post").receipt.verdict, "program_unresolved");
});

test("holds, owner pages, markets and places named in text refuse with the resolver's code", () => {
  const cases = [
    [{ purposes: { [KW]: { post: "promotion_held" } } }, "promotion_held"],
    [{ purposes: { [KW]: { post: "page_not_verified" } } }, "page_not_verified"],
    [{ purposes: { [KW]: { post: "market_unverified" } } }, "market_unverified"],
    [{ purposes: { [KW]: { post: "keyword_wrong_page" } } }, "keyword_wrong_page"],
    [{ geography: { [KW]: "text_only" } }, "place_text_only"],
    [{ geography: { [KW]: "without_market" } }, "place_without_market"],
    [{ geography: { [KW]: "mismatch" } }, "place_mismatch"],
    [{ geography: { [KW]: "unassessed" } }, "geography_unassessed"],
  ];
  for (const [opts, code] of cases) {
    const i = scoped((x) => { x.authority.core = approvedCore(x, opts); });
    const v = coreVerdict(i, KW, ROOF, "post");
    assert.equal(v.ok, false, code);
    assert.equal(v.receipt.verdict, code);
    const r = runAuthority(i);
    assert.ok(!ready(r).some((o) => o.target.keyword_id === KW), `${code}: KW must not be Ready`);
    assert.equal(r.keywords.find((k) => k.keyword_id === KW).core.post, code);
  }
  // A refused keyword gives way to the next usable core keyword of the same intent.
  const r = runAuthority(scoped((x) => {
    x.keywords.push({ id: "kw-res", keyword: "residential roof replacement wentzville", intent: "commercial", intent_note: null, is_active: true,
      is_tracked: true, is_money: false, service_id: ROOF, target_url: x.services[0].page_url, priority: "p2" });
    x.authority.core = approvedCore(x, { purposes: { [KW]: { post: "promotion_held" } } });
  }));
  const c = byKey(r, `gbp_post:${ROOF}:commercial`);
  assert.equal(c.target.keyword_id, "kw-res");
  assert.equal(c.core.verdict, null);
});

const MISSING = { verdict: "missing", method: "http", checked_at: "2026-10-28T12:00:00Z" };
test("a page that does not exist yet: only its own absence is tolerated for a new service page", () => {
  const ok = runAuthority(scoped((x) => { x.authority.core = approvedCore(x, { purposes: { "kw-storm": { post: "target_page_missing" } }, checks: { "kw-storm": MISSING } }); }));
  assert.equal(gate(byKey(ok, `service_page:${STORM}`), "core_keyword").pass, true);
  const held = runAuthority(scoped((x) => { x.authority.core = approvedCore(x, { purposes: { "kw-storm": { post: "promotion_held" } } }); }));
  const h = byKey(held, `service_page:${STORM}`);
  assert.equal(h.action, "blocked_data_prerequisite");
  assert.equal(h.core.verdict, "promotion_held");
  const off = runAuthority(scoped((x) => { x.authority.core = approvedCore(x, { exclude: ["kw-storm"] }); }));
  assert.equal(byKey(off, `service_page:${STORM}`).core.verdict, "keyword_not_core");
  assert.equal(byKey(off, `service_page:${STORM}`).action, "blocked_data_prerequisite");
});

test("a page improvement keeps its fix but drops an off-list keyword target", () => {
  const r = runAuthority(scoped((x) => { x.authority.core = approvedCore(x, { exclude: [KW] }); }));
  const p = byKey(r, `page_improvement:${ROOF}`);
  assert.equal(p.action, "improve");
  assert.equal(p.target.keyword_id, null);
  assert.equal(p.core.verdict, "keyword_not_core");
  assert.ok(p.reasons.some((x) => /No keyword target: Core 50 keyword_not_core/.test(x.text)));
  const on = byKey(runAuthority(lucasAuthority()), `page_improvement:${ROOF}`);
  assert.equal(on.target.keyword_id, KW);
});

test("receipts: every keyword-targeted content opportunity carries program, list, keyword, parent, owner and verdict", () => {
  const r = runAuthority(lucasAuthority());
  const targeted = r.opportunities.filter((o) => o.service_id && /^(gbp_post|service_page|page_improvement):/.test(o.key));
  assert.ok(targeted.length >= 5);
  for (const o of targeted) {
    assert.equal(o.core.schema, "authority-core-v1");
    assert.deepEqual([o.core.program_id, o.core.list_id, o.core.list_version], [null, CORE_LIST, 2]);
    assert.ok(["post", "add", "refresh"].includes(o.core.purpose));
    if (o.section === "ready") assert.deepEqual([o.core.verdict, o.core.relation, o.core.keyword_id, o.core.core_keyword_id], [null, "core", o.target.keyword_id, o.target.keyword_id]);
  }
  assert.equal(r.core.programs[0].list_id, CORE_LIST);
  assert.deepEqual(r.core.programs[0].keyword_ids, [...r.core.programs[0].keyword_ids].sort());
  assert.equal(r.core.loaded, true);
});

test("proposal → approval re-run: the same opportunity keys (rows are updated, never duplicated)", () => {
  const proposed = runAuthority(scoped((x) => { x.authority.core = approvedCore(x, { status: "proposed_only", proposal: PROPOSAL }); }));
  const approved = runAuthority(lucasAuthority());
  const keys = (r) => r.opportunities.map((o) => o.key).filter((k) => !k.startsWith("core_list:")).sort();
  assert.deepEqual(keys(proposed), keys(approved));
  assert.deepEqual(runAuthority(lucasAuthority()).opportunities, approved.opportunities, "deterministic");
  const moved = approved.opportunities.filter((o) => o.section === "ready").map((o) => o.key);
  assert.ok(moved.length && moved.every((k) => proposed.opportunities.find((o) => o.key === k).section === "blocked"));
});

test("an exempt client passes, labelled exempt; no list decision is raised", () => {
  const r = runAuthority(scoped((x) => { x.authority.core = approvedCore(x, { status: "missing", exempt: true }); }));
  assert.ok(ready(r).length > 0);
  assert.ok(ready(r).every((o) => o.core.relation === "exempt" && /exemption/.test(o.core.detail)));
  assert.ok(!r.opportunities.some((o) => o.key.startsWith("core_list:")));
  assert.equal(r.core.exempt, true);
});

test("campaigns: a cluster holds only grounded keywords; the rest are excluded with the reason", () => {
  const r = runAuthority(scoped((x) => { x.authority.core = approvedCore(x, { exclude: ["kw-info"] }); }));
  const c = r.campaigns.find((x) => x.service_id === ROOF);
  assert.ok(!c.cluster.some((k) => k.id === "kw-info"));
  assert.deepEqual(c.excluded.find((e) => e.keyword === "how long does a roof last"), { keyword: "how long does a roof last", reason: "keyword_not_core" });
});

// ── Review fixes (ChatGPT, PR #206 at aaa14c4) ────────────────────────────────

// Every Roof Replacement keyword a Business Profile post could target.
const ROOF_POST_KWS = [KW, "kw-info", "kw-trans"];
const allRoof = (opts) => Object.fromEntries(ROOF_POST_KWS.map((id) => [id, opts]));
const gbp = (r, service = ROOF) => r.campaigns.find((c) => c.service_id === service).channels.find((c) => c.channel === "google_business");

test("campaigns: an approved list whose every GBP keyword is held, stale or text-only never shows review_plan", () => {
  const cases = [
    [{ purposes: allRoof({ post: "promotion_held" }) }, "promotion_held"],
    [{ purposes: allRoof({ post: "page_not_verified" }) }, "page_not_verified"],
    [{ geography: allRoof("text_only") }, "place_text_only"],
    [{ purposes: allRoof({ post: "market_unverified" }) }, "market_unverified"],
  ];
  for (const [opts, code] of cases) {
    const r = runAuthority(scoped((x) => { x.authority.core = approvedCore(x, opts); }));
    const ch = gbp(r);
    assert.notEqual(ch.status, "review_plan", code);
    assert.equal(ch.status, "blocked", code);
    assert.deepEqual(ch.opportunity_keys, [], code);
    assert.ok(ch.blocked_by.length >= 1 && ch.blocked_by.every((b) => b.reason === code), `${code}: ${JSON.stringify(ch.blocked_by)}`);
    // Grounded membership stays visible for reporting, with the code that stops each post.
    const c = r.campaigns.find((x) => x.service_id === ROOF);
    for (const id of ROOF_POST_KWS) assert.equal(c.cluster.find((k) => k.id === id)?.post, code, `${code} ${id}`);
    assert.ok(!ready(r).some((o) => o.service_id === ROOF && o.content_type === "gbp_post"));
  }
});

test("campaigns: one usable core keyword keeps its channel plan; the blocked ones are listed, not hidden", () => {
  const r = runAuthority(scoped((x) => { x.authority.core = approvedCore(x, { purposes: { [KW]: { post: "promotion_held" }, "kw-info": { post: "page_not_verified" } } }); }));
  const ch = gbp(r);
  assert.equal(ch.status, "review_plan");
  assert.deepEqual(ch.opportunity_keys, [`gbp_post:${ROOF}:transactional`]);
  assert.deepEqual(ch.blocked_by.map((b) => [b.key, b.reason]).sort(), [
    [`gbp_post:${ROOF}:commercial`, "promotion_held"],
    [`gbp_post:${ROOF}:informational`, "page_not_verified"],
  ]);
  // Every opportunity_key a campaign lists is actionable: tier A–C and no Core 50 refusal.
  for (const c of r.campaigns) for (const x of c.channels) for (const k of x.opportunity_keys) {
    const o = byKey(r, k);
    assert.notEqual(o.tier, "none", k);
    assert.equal(o.core?.verdict ?? null, null, k);
  }
});

test("campaigns: blocked opportunities never plan a channel, across proposal-only and off-list states", () => {
  // Proposal only: every site campaign. Roof's keywords off the list: Roof's
  // campaign (Storm's new page, still on the list, rightly stays planned).
  for (const [opts, only] of [[{ status: "proposed_only", proposal: PROPOSAL }, null], [{ exclude: ROOF_POST_KWS }, ROOF]]) {
    const r = runAuthority(scoped((x) => { x.authority.core = approvedCore(x, opts); }));
    for (const c of r.campaigns.filter((x) => !only || x.service_id === only)) for (const ch of c.channels) {
      assert.notEqual(ch.status, "review_plan", `${c.name} ${ch.channel}`);
      assert.deepEqual(ch.opportunity_keys, []);
    }
  }
});

test("campaigns: an off-list primary is never the campaign's primary, objective or priority", () => {
  const r = runAuthority(scoped((x) => { x.authority.core = approvedCore(x, { exclude: [KW] }); }));
  const c = r.campaigns.find((x) => x.service_id === ROOF);
  assert.equal(c.primary, null);
  assert.deepEqual(c.primary_excluded, { keyword: "roof replacement wentzville", reason: "keyword_not_core" });
  assert.doesNotMatch(c.objective, /roof replacement wentzville/);
  assert.ok(!c.cluster.some((k) => k.id === KW));
  assert.ok(c.blockers.some((b) => /primary keyword "roof replacement wentzville" is not usable for this site \(keyword_not_core\)/.test(b)));
  assert.deepEqual(c.priority, [4]);
  assert.ok(c.channels.every((ch) => ch.status !== "review_plan"));
  // With the primary on the list, it is the campaign's primary.
  const on = runAuthority(lucasAuthority()).campaigns.find((x) => x.service_id === ROOF);
  assert.equal(on.primary.id, KW);
  assert.equal(on.primary_excluded, null);
});

test("new service page: an existing page that is unchecked, stale, unreadable, redirected or soft-404 is verified, never re-created", () => {
  const stale = { verdict: "live", method: "http", checked_at: "2026-08-01T12:00:00Z" };
  const cases = [
    ["page_not_verified", null, /never checked/],
    ["page_not_verified", stale, /live by http on 2026-08-01/],
    ["target_page_missing", { verdict: "unreadable", method: "http", checked_at: "2026-10-28T12:00:00Z" }, /unreadable/],
    ["target_page_missing", { verdict: "redirected", method: "http", checked_at: "2026-10-28T12:00:00Z" }, /redirected/],
    ["target_page_missing", { verdict: "soft_404", method: "http", checked_at: "2026-10-28T12:00:00Z" }, /soft_404/],
    ["target_page_missing", { verdict: "wrong_host", method: "http", checked_at: "2026-10-28T12:00:00Z" }, /wrong_host/],
  ];
  for (const [code, check, detail] of cases) {
    const r = runAuthority(scoped((x) => { x.authority.core = approvedCore(x, { purposes: { "kw-storm": { post: code } }, checks: { "kw-storm": check } }); }));
    const o = byKey(r, `service_page:${STORM}`);
    assert.equal(o.core.verdict, "page_absence_unverified", `${code} ${check?.verdict}`);
    assert.match(o.core.detail, /existing page that is not proven missing/);
    assert.match(o.core.detail, detail);
    assert.match(o.core.detail, /check it before proposing a new page/);
    assert.equal(o.action, "blocked_data_prerequisite");
    assert.notEqual(o.section, "fix_now");
  }
  // Proven absence: a real 404, or no page claimed at all.
  const i = scoped((x) => { x.authority.core = approvedCore(x, { purposes: { "kw-storm": { post: "target_page_missing" } }, checks: { "kw-storm": MISSING } }); });
  assert.equal(coreVerdict(i, "kw-storm", STORM, "add").ok, true);
  const none = scoped((x) => { x.keywords.find((k) => k.id === "kw-storm").target_url = null; x.authority.core = approvedCore(x, { purposes: { "kw-storm": { post: "target_page_missing" } } }); });
  assert.equal(coreVerdict(none, "kw-storm", STORM, "add").ok, true);
  // The exception is for new pages only: the same keyword is still refused for a post.
  assert.equal(coreVerdict(i, "kw-storm", STORM, "post").receipt.verdict, "target_page_missing");
});
