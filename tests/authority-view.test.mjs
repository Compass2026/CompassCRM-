// The Authority tab's view model (src/lib/authority-view.ts) over a trimmed
// export of the production Lucas run (tests/fixtures/authority-lucas-run.json):
// grouping, what is open by default, labels, demand, provenance, staleness,
// banners and run history. Pure: no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildAuthorityView, actionLabel, demandOf, provenanceCounts, staleness, historyRows, changesText,
  ORDER_IMPRESSIONS_INDEX, RESEARCH_VISIBLE,
} from "../src/lib/authority-view.ts";
import { prioritize } from "../supabase/functions/authority/opportunities.ts";

const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/authority-lucas-run.json", import.meta.url), "utf8"));
const FULL = FX.meta.run;
const REFRESH_ID = "9aeb1edb-1d85-425c-92d2-1981f00354f1";
const TEAM = "11111111-1111-4111-8111-111111111111";

const runs = () => [
  { id: REFRESH_ID, created_at: "2026-09-26T03:57:56.696Z", finished_at: "2026-09-26T03:57:57.246Z", status: "completed", mode: "refresh", requested_via: "worker", requested_by: null,
    inventory_fetched_at: FULL.inventory_fetched_at, inventory_pages: 64, inventory_errors: 0, diff: { added: [], resolved: [], regressed: [], section_changed: [], reopened: [] }, error: null, health: { status: "completed", reasons: [] } },
  { id: FULL.id, created_at: FULL.created_at, finished_at: FULL.finished_at, status: "completed", mode: "full", requested_via: "team", requested_by: TEAM,
    inventory_fetched_at: FULL.inventory_fetched_at, inventory_pages: 64, inventory_errors: 0, diff: { added: FX.opportunities.map((o) => o.key), resolved: [], regressed: [], section_changed: [], reopened: [] }, error: null, health: { status: "completed", reasons: [] } },
];
const latest = (over = {}) => ({
  run_id: REFRESH_ID, finished_at: "2026-09-26T03:57:57.246Z", judged_at: "2026-09-26T03:57:56.8Z", mode: "refresh", engine_version: "authority-v1.1",
  counts: FX.meta.counts, sources: FX.meta.sources, inventory_fetched_at: FULL.inventory_fetched_at, stale_sections: [], inventory_stale: false, ...over,
});
const input = (over = {}) => ({
  latest: latest(), runs: runs(), opportunities: FX.opportunities, pillars: FX.meta.pillars,
  states: FX.opportunities.map((o, i) => ({ id: `s${i}`, key: o.key, effective_status: "open", present: true, first_seen_run_id: FULL.id, last_seen_run_id: REFRESH_ID })),
  events: FX.opportunities.map((_, i) => ({ opportunity_id: `s${i}`, run_id: FULL.id, created_at: FULL.finished_at, kind: "created", actor_kind: "engine" })),
  members: [{ id: TEAM, name: "Sam Team", email: "sam@example.test" }],
  ...over,
});
const section = (v, s) => v.sections.find((x) => x.section === s);
const group = (v, s, id) => section(v, s).groups.find((g) => g.id === id);
const card = (v, key) => v.sections.flatMap((s) => s.groups.flatMap((g) => g.cards)).find((c) => c.key === key);

test("the fixture is the production Lucas run", () => {
  assert.equal(FX.opportunities.length, 68);
  assert.equal(new Set(FX.opportunities.map((o) => o.key)).size, 68);
  assert.equal(FX.meta.sources.gsc.rows, 825);
  assert.equal(FX.meta.sources.gsc.coverage, "complete");
});

test("summary: the five sections with the stored counts (Avoid is not a card)", () => {
  const v = buildAuthorityView(input());
  assert.deepEqual(v.summary.map((s) => [s.section, s.count]), [["fix_now", 23], ["ready", 2], ["needs_decision", 27], ["research", 3], ["blocked", 9]]);
  for (const s of v.summary) assert.equal(s.count, section(v, s.section).count, `${s.section}: stored count = report count`);
  assert.equal(section(v, "avoid").count, 4);
  assert.equal(v.sections.reduce((n, s) => n + s.count, 0), 68, "every opportunity lands in exactly one section");
});

test("Fix Now: Tier A open first, B and C collapsed with counts, engine order kept", () => {
  const v = buildAuthorityView(input());
  const g = section(v, "fix_now").groups;
  assert.deepEqual(g.map((x) => [x.label, x.count, x.open]), [["Tier A", 6, true], ["Tier B", 16, false], ["Tier C", 1, false]]);
  assert.deepEqual(g[0].cards.map((c) => c.topic), ["Roof Repair", "Roof Replacement", "Home page", "Roof Replacement", "Siding Installation & Repair", "Soffit & Fascia Replacement"]);
  const engineOrder = FX.opportunities.filter((o) => o.section === "fix_now").map((o) => o.key);
  assert.deepEqual(g.flatMap((x) => x.cards.map((c) => c.key)), engineOrder);
});

test("the Roof Repair create-page card carries everything shown by default", () => {
  const c = card(buildAuthorityView(input()), "service_page:c1c55a67-bc9f-43d1-a3a6-ad9bfe96841d");
  assert.equal(c.action, "Create the page");
  assert.equal(c.tier, "A");
  assert.equal(c.reason, "The owner page /services/roof-repair is missing.");
  assert.deepEqual(c.target, { path: "/services/roof-repair", state: "missing" });
  assert.equal(c.keyword, "roof repair wentzville mo");
  assert.equal(c.intent, "navigational");
  assert.equal(c.demand, 1690);
  assert.equal(c.evidence, 3);
  assert.equal(c.blocker, null);
  assert.ok(c.provenance.find((p) => p.tag === "FACT").count >= 3);
  assert.equal(c.lifecycle, "open");
  assert.equal(c.details.history[0].kind, "created");
  assert.ok(c.details.firstSeen && c.details.lastSeen);
});

test("home, Roof Replacement and keyword re-home cards", () => {
  const v = buildAuthorityView(input());
  const home = card(v, "page_improvement:home");
  assert.equal(home.action, "Fix the page's wording");
  assert.equal(home.demand, 12573);
  assert.equal(home.target.path, "/");
  const rr = card(v, "page_improvement:4288b96c-db9f-436e-b492-78f5fa7f1f21");
  assert.deepEqual(rr.target, { path: "/services/roof-replacement", state: "live" });
  assert.equal(rr.demand, 2115);
  const rehome = card(v, "data_fix:keyword-ownership:4288b96c-db9f-436e-b492-78f5fa7f1f21");
  assert.equal(rehome.action, "Fix CRM data");
  assert.equal(rehome.reason, "15 keywords under Roof Replacement target the home page.");
});

test("Ready: ready now open; the cadence item collapsed with its next eligible date", () => {
  const v = buildAuthorityView(input());
  const [now, waiting] = section(v, "ready").groups;
  assert.deepEqual([now.label, now.count, now.open], ["Ready now", 1, true]);
  assert.equal(now.cards[0].key, "gbp_post:4288b96c-db9f-436e-b492-78f5fa7f1f21:transactional");
  assert.equal(now.cards[0].action, "Draft a Business Profile post");
  assert.equal(now.cards[0].intent, "transactional");
  assert.deepEqual([waiting.label, waiting.count, waiting.open], ["Waiting on cadence", 1, false]);
  assert.equal(waiting.note, "Next eligible Oct 16, 2026");
});

test("Needs Decision: Services, Markets and Intent conflicts, one row each; small groups open", () => {
  const v = buildAuthorityView(input());
  assert.deepEqual(section(v, "needs_decision").groups.map((g) => [g.label, g.count, g.open]), [["Services", 1, true], ["Markets", 19, false], ["Intent conflicts", 7, false]]);
  const svc = group(v, "needs_decision", "decide-services").cards[0];
  assert.equal(svc.key, "confirm_service:/services/commercial-roofing");
  assert.deepEqual(svc.target, { path: "/services/commercial-roofing", state: "live" });
  const markets = group(v, "needs_decision", "decide-markets").cards;
  assert.ok(markets.every((c) => c.key.startsWith("confirm_market:")));
  assert.ok(markets.some((c) => c.topic === "Market: Wright City" && c.target.path === "/service-areas/wright-city"));
  assert.ok(group(v, "needs_decision", "decide-intents").cards.every((c) => c.intent === "navigational" && c.keyword));
});

test("Research: the first few shown, the rest collapsed once the list grows", () => {
  const v = buildAuthorityView(input());
  assert.deepEqual(section(v, "research").groups.map((g) => [g.count, g.open]), [[3, true]]);
  assert.match(section(v, "research").groups[0].cards[0].reason, /Client Intelligence does not hold/);
  const more = [...FX.opportunities, ...FX.opportunities.filter((o) => o.section === "research").map((o) => ({ ...o, key: `${o.key}-copy`, id: `${o.id}-copy` }))];
  const g = section(buildAuthorityView(input({ opportunities: more })), "research").groups;
  assert.deepEqual(g.map((x) => [x.count, x.open]), [[RESEARCH_VISIBLE, true], [3, false]]);
  assert.equal(g[1].label, "3 more");
});

test("Blocked: grouped by what unblocks them, each data prerequisite linked to its Fix Now item", () => {
  const v = buildAuthorityView(input());
  const g = section(v, "blocked").groups;
  assert.equal(g.reduce((n, x) => n + x.count, 0), 9);
  assert.ok(g.every((x) => !x.open), "blocked groups start collapsed");
  const gutters = g.find((x) => x.link?.anchor === "opp-data_fix:service-page:gutter-installation-repair");
  assert.equal(gutters.label, "Set Gutter Installation & Repair's service page to /services/gutters (now empty).");
  assert.equal(gutters.count, 1);
  const holiday = g.find((x) => x.link?.anchor === "opp-data_fix:service-page:holiday-lighting-installation");
  assert.equal(holiday.count, 2, "both Holiday Lighting posts wait on one fix");
  assert.equal(g.filter((x) => x.link).length, 5);
  assert.equal(g.find((x) => x.label === "Needs a client-confirmed fact.").count, 2);
  assert.equal(g.find((x) => x.label === "Needs a usable claim").cards[0].key, "evidence:unsupported-materials");
  const anchors = new Set(v.sections.flatMap((s) => s.groups.flatMap((x) => x.cards.map((c) => c.anchor))));
  for (const x of g.filter((y) => y.link)) assert.ok(anchors.has(x.link.anchor), `${x.link.anchor} exists on the page`);
});

test("Avoid: one collapsed group", () => {
  const g = section(buildAuthorityView(input()), "avoid").groups;
  assert.deepEqual(g.map((x) => [x.count, x.open]), [[4, false]]);
  assert.equal(g[0].cards[0].action, "Don't target");
});

test("labels, demand and provenance", () => {
  assert.equal(actionLabel({ action: "blocked_data_prerequisite", content_type: "gbp_post" }), "Blocked on CRM data");
  assert.equal(actionLabel({ action: "consolidate", content_type: "blog_refresh" }), "Merge overlapping posts");
  assert.equal(demandOf({ order: [0, -3, -3, -4, 0, 0, -12573] }), 12573);
  assert.equal(demandOf({ order: [0, 0, 0, 0, 0, 0, 0] }), 0);
  assert.deepEqual(provenanceCounts([{ tag: "HEURISTIC", text: "a" }, { tag: "FACT", text: "b" }, { tag: "FACT", text: "c" }]), [{ tag: "FACT", count: 2 }, { tag: "HEURISTIC", count: 1 }]);
});

test("demand reads the slot prioritize() fills with impressions", () => {
  const draft = {
    id: "x", key: "page_improvement:x", topic: "X", service_id: null, action: "improve", content_type: "page_improvement",
    target: { keyword_id: null, keyword: null, intent: null, location: null, owner_path: "/x", cta: null },
    evidence_claim_ids: [], existing_coverage: [], gap: "g", blockers: [], gates: [], eligible_from: null, reasons: [],
    value: 3, severity: 3, impressions: 4321, deferred: false,
  };
  const [o] = prioritize([draft]);
  assert.equal(o.order[ORDER_IMPRESSIONS_INDEX], -4321);
  assert.equal(demandOf(o), 4321);
});

test("header: current state, mode, engine, pages and Search Console coverage", () => {
  const v = buildAuthorityView(input());
  assert.equal(v.empty, false);
  assert.deepEqual(v.header, {
    lastAnalyzed: "Sep 25, 10:57 PM", mode: "Refresh", engine: "authority-v1.1", pagesChecked: 60, urlsRequested: 64,
    gsc: { coverage: "complete", rows: 825, window: "Aug 26 – Sep 22", cap: null }, state: "current",
  });
  assert.deepEqual(v.banners, []);
});

test("staleness wording: CRM changes need a refresh; the site record or an old inventory needs a full run", () => {
  assert.equal(staleness({ stale_sections: [], inventory_stale: false }).stale, false);
  const kw = staleness({ stale_sections: ["gsc", "keywords"], inventory_stale: false });
  assert.equal(kw.needs, "refresh");
  assert.equal(kw.message, "Since this analysis: a newer Search Console window, keywords changed. A refresh (re-judging with the stored site inventory) will bring it up to date.");
  assert.equal(staleness({ stale_sections: ["site"], inventory_stale: false }).needs, "full");
  const old = staleness({ stale_sections: [], inventory_stale: true });
  assert.equal(old.needs, "full");
  assert.match(old.message, /more than 14 days old/);
  const v = buildAuthorityView(input({ latest: latest({ stale_sections: ["keywords"] }) }));
  assert.equal(v.header.state, "stale");
  assert.equal(v.banners[0].kind, "stale");
});

test("banners: running, and a newer degraded or failed attempt that did not replace the results", () => {
  const failed = { ...runs()[0], id: "f1", created_at: "2026-09-27T10:00:00Z", finished_at: "2026-09-27T10:00:03Z", status: "failed", mode: "full", diff: null, error: "inventory exploded", inventory_pages: null, health: null };
  const v = buildAuthorityView(input({ runs: [failed, ...runs()] }));
  assert.equal(v.header.state, "attempt_problem");
  assert.equal(v.banners[0].kind, "failed");
  assert.match(v.banners[0].body, /inventory exploded/);
  const degraded = { ...failed, id: "d1", status: "degraded", error: null, diff: { skipped: "degraded run: opportunities unchanged" }, health: { reasons: ["home page answered 503"] }, inventory_pages: 64, inventory_errors: 40 };
  const d = buildAuthorityView(input({ runs: [degraded, ...runs()] }));
  assert.equal(d.banners[0].kind, "degraded");
  assert.match(d.banners[0].body, /home page answered 503/);
  const running = { ...failed, id: "r1", status: "running", finished_at: null, error: null };
  const r = buildAuthorityView(input({ runs: [running, ...runs()] }));
  assert.equal(r.header.state, "running");
  assert.equal(r.banners[0].kind, "running");
  const older = { ...failed, created_at: "2026-09-20T10:00:00Z", finished_at: "2026-09-20T10:00:03Z" };
  assert.deepEqual(buildAuthorityView(input({ runs: [...runs(), older] })).banners, [], "an older failure is history, not a banner");
});

test("run history: current run marked, changes, inventory, who", () => {
  const rows = historyRows(runs(), REFRESH_ID, [{ id: TEAM, name: "Sam Team", email: "sam@example.test" }]);
  assert.deepEqual(rows.map((r) => [r.mode, r.status, r.by, r.changes, r.current]), [
    ["Refresh", "completed", "worker", "no change", true],
    ["Full", "completed", "Sam Team", "+68 added", false],
  ]);
  assert.match(rows[0].inventory, /^reused from /);
  assert.equal(rows[1].inventory, "64 URLs · 0 errors · Sep 25, 10:56 PM");
  assert.equal(changesText({ status: "degraded", diff: { skipped: "x" } }), "unchanged (degraded)");
  assert.equal(changesText({ status: "failed", diff: null }), "—");
  assert.equal(changesText({ status: "completed", diff: { added: ["a"], resolved: ["b", "c"], section_changed: ["d"], regressed: [], reopened: [] } }), "+1 added · −2 resolved · 1 moved");
});

test("no run yet: the empty state, with any failed attempts still listed", () => {
  const failed = { ...runs()[0], id: "f1", status: "failed", mode: "full", diff: null, error: "boom", inventory_pages: null, health: null };
  const v = buildAuthorityView(input({ latest: null, runs: [failed], opportunities: [] }));
  assert.equal(v.empty, true);
  assert.equal(v.header, null);
  assert.equal(v.history.length, 1);
  assert.equal(v.banners[0].kind, "failed");
  assert.equal(buildAuthorityView(input({ latest: null, runs: [], opportunities: [] })).banners.length, 0);
});
