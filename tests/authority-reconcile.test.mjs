// Authority reconciliation (C2) rules: rows from structured fields only,
// before → after for every field written, the 0052 bindings in each row's
// expected state, nothing preselected, at most 25, unapproved markets blocked,
// the partial record-content state. Pure: no network, no database. The Lucas
// case runs the engine over the trimmed production export
// (tests/fixtures/authority-lucas-home.json) and assembles the preview's facts
// the way previewReconcileAction does.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MARKET_FIRST, MAX_SELECTED, buildApply, mapChanges, mapRows, reconcileAction, reconcileServiceId, recordProgress, recordRows,
  rehomeRows, remainingPaths, resultText, servicePageRow,
} from "../src/lib/authority-reconcile.ts";
import { historyLine } from "../src/lib/authority-lifecycle.ts";
import { runAuthority } from "../supabase/functions/authority/engine.ts";
import { normPath } from "../supabase/functions/authority/urls.ts";
import { lucasHomeInput, LUCAS_HOME } from "./helpers/lucas-home-input.mjs";

const SVC = "11111111-1111-4111-8111-111111111111";
const BASE = { run_id: "r", status: "open", suppressed: false, dismissed_until: null };
const kw = (id, keyword, flags, extra = {}) => ({ keyword_id: id, keyword, service_id: SVC, role: "homepage_pollution", flags, ...extra });
const cur = (id, keyword, service_id = SVC, target_url = "https://x.test/") => [id, { id, keyword, service_id, target_url, target_path: normPath(target_url, "https://x.test") }];

test("which reconciliation a key takes", () => {
  assert.equal(reconcileAction(`data_fix:service-page:${SVC}`), "set_service_page");
  assert.equal(reconcileAction(`data_fix:keyword-ownership:${SVC}`), "rehome_keywords");
  assert.equal(reconcileAction("data_fix:record-live-blog-posts"), "record_content");
  assert.equal(reconcileAction("data_fix:unmapped-keywords"), "map_keywords");
  for (const k of ["confirm_market:x", "page_improvement:home", "data_fix:other"]) assert.equal(reconcileAction(k), null);
  assert.equal(reconcileServiceId(`data_fix:keyword-ownership:${SVC}`), SVC);
});

test("set service page: before → after and the 0052 target binding", () => {
  const group = { id: "g", name: "Gutters", target_url: "https://x.test/gutters", path: "/gutters", live: true };
  const r = servicePageRow({ service: { id: SVC, name: "Gutters", status: "approved", page_url: null, page_path: null }, group });
  assert.equal(r.enabled, true);
  assert.deepEqual(r.changes, [{ record: "services · Gutters", field: "page_url", before: "—", after: "https://x.test/gutters" }]);
  assert.deepEqual(r.expected, { page_url: null, target_url: "https://x.test/gutters" });
  const built = buildApply("set_service_page", BASE, [r], []);
  assert.deepEqual(built, { payload: {}, expected: { ...BASE, page_url: null, target_url: "https://x.test/gutters" } });
  const off = (a) => servicePageRow(a).enabled;
  assert.equal(off({ service: null, group }), false);
  assert.equal(off({ service: { id: SVC, name: "G", status: "proposed", page_url: null, page_path: null }, group }), false);
  assert.equal(off({ service: { id: SVC, name: "G", status: "approved", page_url: null, page_path: null }, group: { ...group, live: false } }), false);
  assert.equal(off({ service: { id: SVC, name: "G", status: "approved", page_url: "/gutters", page_path: "/gutters" }, group }), false);
  assert.ok("error" in buildApply("set_service_page", BASE, [servicePageRow({ service: null, group })], []));
});

function rehome(extra = {}) {
  return rehomeRows({
    service: { id: SVC, name: "Roof Replacement" },
    report: [
      kw("k1", "roofer near me", ["homepage_pollution", "home_eligible"]),
      kw("k2", "roofer in town", ["homepage_pollution", "home_ambiguous"]),
      kw("k3", "roof replacement near me", ["homepage_pollution"]),
      kw("k4", "roofing company", ["homepage_pollution", "home_eligible"]),
      kw("k5", "not polluted", ["home_eligible"]),
      kw("k6", "changed meanwhile", ["homepage_pollution", "home_eligible"]),
    ],
    current: new Map([cur("k1", "roofer near me"), cur("k2", "roofer in town"), cur("k3", "roof replacement near me"), cur("k4", "roofing company"),
      cur("k6", "changed meanwhile", SVC, "https://x.test/roof-replacement")]),
    serviceGroup: { id: "grr", name: "Roof Replacement", target_url: "https://x.test/roof-replacement", path: "/roof-replacement", live: true },
    home: { id: "gh", name: "Home", target_url: "https://x.test/", path: "/", live: true, valid: true, reason: null, supporting: ["k4"], primary: null },
    primaryIds: new Set(),
    listing: new Map([["k1", [{ id: "b-city", name: "City" }, { id: "a-rr", name: "Roof Replacement" }].sort((a, b) => a.id.localeCompare(b.id))]]),
    ownerKeys: new Set(["confirm_owner:k2"]),
    ...extra,
  });
}

test("re-home: Home rows name every group they leave; ambiguous ones point at their decision", () => {
  const rows = rehome();
  assert.deepEqual(rows.map((r) => r.id), ["k1", "k2", "k3", "k4", "k6"], "homepage_pollution rows of this service only");
  const [k1, k2, k3, k4, k6] = rows;
  assert.equal(k1.enabled, true);
  assert.deepEqual(k1.payload, { keyword_id: "k1", destination: "home" });
  assert.deepEqual(k1.expected, { keyword_id: "k1", service_id: SVC, target_url: "https://x.test/", destination_url: "https://x.test/", removed_from: ["a-rr", "b-city"] });
  assert.deepEqual(k1.changes.map((c) => `${c.record}.${c.field}: ${c.before} → ${c.after}`), [
    "keywords · roofer near me.service_id: Roof Replacement → — (no service; Home owns it)",
    "keywords · roofer near me.target_url: https://x.test/ → https://x.test/",
    "page_groups · Roof Replacement.supporting_keyword_ids: lists \"roofer near me\" → \"roofer near me\" removed",
    "page_groups · City.supporting_keyword_ids: lists \"roofer near me\" → \"roofer near me\" removed",
    "page_groups · Home.supporting_keyword_ids: — → \"roofer near me\" added",
  ]);
  assert.equal(k2.enabled, false);
  assert.match(k2.reason, /Ownership/);
  assert.deepEqual(k2.links, [{ key: "confirm_owner:k2", label: "Ownership decision" }]);
  assert.deepEqual(k3.payload, { keyword_id: "k3", destination: "service_page" });
  assert.equal(k3.expected.destination_url, "https://x.test/roof-replacement");
  assert.equal(k3.expected.removed_from, undefined, "a service-page row leaves no group");
  assert.match(k4.changes.at(-1).after, /already listed/);
  assert.equal(k6.enabled, false, "a keyword changed since the analysis is not offered");
  // No live service page: the service-specific row has nowhere to go.
  const noPage = rehome({ serviceGroup: { id: "g", name: "Roof Repair", target_url: "https://x.test/roof-repair", path: "/roof-repair", live: false } });
  assert.equal(noPage.find((r) => r.id === "k3").enabled, false);
  // A primary keyword and an invalid Home are refused up front.
  assert.equal(rehome({ primaryIds: new Set(["k1"]) })[0].enabled, false);
  assert.equal(rehome({ home: null })[0].enabled, false);
});

test("selection: none preselected, at most 25, only offered rows, never twice", () => {
  const rows = rehome();
  assert.match(buildApply("rehome_keywords", BASE, rows, []).error, /at least one/);
  assert.match(buildApply("rehome_keywords", BASE, rows, [{ id: "k2" }]).error, /not available/);
  assert.match(buildApply("rehome_keywords", BASE, rows, [{ id: "k1" }, { id: "k1" }]).error, /twice/);
  const many = Array.from({ length: MAX_SELECTED + 1 }, (_, i) => ({ id: `r${i}` }));
  assert.match(buildApply("rehome_keywords", BASE, rows, many).error, /at most 25/);
  const ok = buildApply("rehome_keywords", BASE, rows, [{ id: "k1" }, { id: "k3" }]);
  assert.deepEqual(ok.payload.rows, [{ keyword_id: "k1", destination: "home" }, { keyword_id: "k3", destination: "service_page" }]);
  assert.deepEqual(ok.expected.rows.map((r) => r.keyword_id), ["k1", "k3"]);
  assert.equal(ok.expected.run_id, "r");
});

test("record content: rows only from candidate_paths; recorded, off-route and not-live pages unavailable", () => {
  assert.equal(recordRows({ candidates: undefined, prefix: "/blog/", pages: new Map(), recorded: new Set() }), null, "no structured list: no rows");
  const pages = new Map([
    ["/blog/a", { state: "live", title: "A", url: "https://x.test/blog/a" }],
    ["/blog/b", { state: "live", title: "B", url: "https://x.test/blog/b" }],
    ["/blog/c", { state: "missing", title: "/blog/c", url: null }],
  ]);
  const rows = recordRows({ candidates: ["/blog/a", "/blog/b", "/blog/c", "/news/d"], prefix: "/blog/", pages, recorded: new Set(["/blog/b"]) });
  assert.deepEqual(rows.map((r) => [r.id, r.enabled]), [["/blog/a", true], ["/blog/b", false], ["/blog/c", false], ["/news/d", false]]);
  assert.match(rows[1].reason, /Already recorded/);
  assert.deepEqual(rows[0].changes.map((c) => c.after), ["A", "https://x.test/blog/a", "published · site_inventory (Not produced by Compass.)"]);
  assert.deepEqual(buildApply("record_content", BASE, rows, [{ id: "/blog/a" }]), { payload: { paths: ["/blog/a"] }, expected: BASE });
  assert.deepEqual(remainingPaths(["/blog/a", "/blog/b"], new Set(["/blog/b"])), ["/blog/a"]);
});

test("partial recording: Partly recorded while the analysis still lists pages; never Completed early", () => {
  const five = ["/blog/1", "/blog/2", "/blog/3", "/blog/4", "/blog/5"];
  assert.equal(recordProgress({ candidates: five, recorded: new Set(), linked: 0 }), null, "nothing recorded yet: the normal chip");
  const p = recordProgress({ candidates: five, recorded: new Set(["/blog/1", "/blog/2"]), linked: 2 });
  assert.equal(p.label, "Partly recorded · 3 remaining");
  assert.equal(p.remaining, 3);
  // After the refresh the analysis lists only the 3 left; the 2 recorded are links.
  assert.equal(recordProgress({ candidates: five.slice(2), recorded: new Set(["/blog/1", "/blog/2"]), linked: 2 }).label, "Partly recorded · 3 remaining");
  assert.equal(recordProgress({ candidates: five, recorded: new Set(five), linked: 5 }).label, "Recorded · awaiting refresh");
  assert.equal(recordProgress({ candidates: undefined, recorded: new Set(), linked: 2 }), null);
});

test("map keywords: unapproved markets block with the market message; no service preselected", () => {
  const rows = mapRows({
    report: [
      { keyword_id: "u1", keyword: "gutter guards", service_id: null, role: "unmapped", flags: [], unapproved_places: [] },
      { keyword_id: "u2", keyword: "christmas lights o'fallon", service_id: null, role: "unmapped", flags: ["location_unapproved"], unapproved_places: ["O'Fallon"] },
      { keyword_id: "u3", keyword: "lights troy", service_id: null, role: "unmapped", flags: ["location_unapproved"], unapproved_places: ["Troy"] },
      { keyword_id: "s1", keyword: "mapped", service_id: SVC, role: "supporting", flags: [] },
    ],
    current: new Map([["u1", { id: "u1", keyword: "gutter guards", service_id: null, target_url: null, target_path: null }],
      ["u2", { id: "u2", keyword: "christmas lights o'fallon", service_id: null, target_url: null, target_path: null }],
      ["u3", { id: "u3", keyword: "lights troy", service_id: null, target_url: null, target_path: null }]]),
    services: [
      { id: "gu", name: "Gutters", group: { id: "gg", name: "Gutters", target_url: "https://x.test/gutters", path: "/gutters", live: true } },
      { id: "rp", name: "Roof Repair", group: { id: "gr", name: "Roof Repair", target_url: "https://x.test/roof-repair", path: "/roof-repair", live: false } },
    ],
    marketKeys: new Map([["ofallon", "confirm_market:ofallon"]]),
    normPlace: (p) => p.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-"),
  });
  assert.deepEqual(rows.map((r) => [r.id, r.enabled]), [["u1", true], ["u2", false], ["u3", false]]);
  assert.equal(rows[1].reason, `${MARKET_FIRST} (O'Fallon)`);
  assert.deepEqual(rows[1].links, [{ key: "confirm_market:ofallon", label: "Market: O'Fallon" }]);
  assert.deepEqual(rows[2].links, [], "no market decision to link to: named, not linked");
  assert.deepEqual(rows[0].options.map((o) => [o.name, o.enabled]), [["Gutters", true], ["Roof Repair", false]]);
  assert.match(buildApply("map_keywords", BASE, rows, [{ id: "u1" }]).error, /Choose a service/, "nothing preselected");
  assert.match(buildApply("map_keywords", BASE, rows, [{ id: "u1", service_id: "rp" }]).error, /Choose a service/, "no live page, no mapping");
  assert.match(buildApply("map_keywords", BASE, rows, [{ id: "u2", service_id: "gu" }]).error, /not available/);
  const ok = buildApply("map_keywords", BASE, rows, [{ id: "u1", service_id: "gu" }]);
  assert.deepEqual(ok.payload, { rows: [{ keyword_id: "u1", service_id: "gu" }] });
  assert.deepEqual(ok.expected.rows, [{ keyword_id: "u1", service_id: null, target_url: null, destination_url: "https://x.test/gutters" }]);
  assert.deepEqual(mapChanges(rows[0], rows[0].options[0]).map((c) => c.after), ["Gutters", "https://x.test/gutters"]);
});

test("answers: success, partial (skipped) and nothing-recorded read clearly", () => {
  assert.equal(resultText("record_content", { rows: [{}, {}], skipped: ["/blog/x"] }).tone, "partial");
  assert.match(resultText("record_content", { rows: [{}, {}], skipped: ["/blog/x"] }).text, /Recorded 2 pages .* 1 already recorded: \/blog\/x/);
  assert.equal(resultText("record_content", { rows: [], skipped: ["/blog/x"] }).tone, "info");
  assert.equal(resultText("rehome_keywords", { rows: [{ destination: "home" }, { destination: "service_page" }] }, { service: "Roof Replacement" }).text,
    "Re-homed 2 keywords: 1 to Home, 1 to Roof Replacement's page.");
  assert.match(resultText("map_keywords", { rows: [{ keyword: "gutter guards", after: { service: "Gutters" } }] }).text, /gutter guards → Gutters/);
});

test("history names the rows a reconciliation wrote", () => {
  const h = historyLine({ opportunity_id: "o", run_id: null, created_at: "2026-09-27T00:00:00Z", kind: "decision", actor_kind: "team",
    detail: { decision: "Record 2 existing page(s) from the client's site", rows: [{ path: "/blog/a" }, { path: "/blog/b" }], skipped: ["/blog/c"] } }, []);
  assert.equal(h.text, "Decision : Record 2 existing page(s) from the client's site (/blog/a, /blog/b) · 1 already recorded");
});

// ── Lucas (read-only export): what the Re-home preview offers ───────────────
test("Lucas: Roof Replacement's re-home offers 14 Home rows, 1 ambiguous row for Ownership, nothing preselected", () => {
  const input = lucasHomeInput();
  const r = runAuthority(input);
  const site = LUCAS_HOME.site.url;
  const roof = LUCAS_HOME.services.find((s) => s.name === "Roof Replacement");
  const groups = input.authority.pageGroupsFull.filter((g) => g.status === "approved");
  const home = groups.find((g) => g.page_type === "home");
  const svcGroups = groups.filter((g) => g.page_type === "service" || g.page_type === "hub");
  const rrGroup = svcGroups.find((g) => g.name === "Roof Replacement");
  const listing = new Map(input.keywords.map((k) => [k.id,
    svcGroups.filter((g) => (g.supporting_keyword_ids ?? []).includes(k.id)).sort((a, b) => a.id.localeCompare(b.id)).map((g) => ({ id: g.id, name: g.name }))]));
  const rows = rehomeRows({
    service: { id: roof.id, name: roof.name },
    report: r.keywords,
    current: new Map(input.keywords.map((k) => [k.id, { id: k.id, keyword: k.keyword, service_id: k.service_id, target_url: k.target_url, target_path: normPath(k.target_url, site) }])),
    serviceGroup: { id: rrGroup.id, name: rrGroup.name, target_url: rrGroup.target_url, path: normPath(rrGroup.target_url, site), live: true },
    home: { id: home.id, name: home.name, target_url: home.target_url, path: normPath(home.target_url, site), live: true, valid: true, reason: null,
      supporting: home.supporting_keyword_ids ?? [], primary: home.primary_keyword_id },
    primaryIds: new Set([...input.services.map((s) => s.primary_keyword_id).filter(Boolean), ...svcGroups.map((g) => g.primary_keyword_id).filter(Boolean)]),
    listing,
    ownerKeys: new Set(r.opportunities.filter((o) => o.key.startsWith("confirm_owner:")).map((o) => o.key)),
  });
  assert.equal(rows.length, 15);
  const on = rows.filter((x) => x.enabled);
  assert.equal(on.length, 14);
  assert.ok(on.every((x) => x.payload.destination === "home" && x.expected.destination_url === home.target_url));
  // 13 leave Roof Replacement's supporting list; "roofer near me" is Home's primary keyword and on no service group.
  assert.deepEqual(on.filter((x) => x.expected.removed_from.length).map((x) => x.expected.removed_from), Array(13).fill([rrGroup.id]));
  const primary = on.find((x) => x.label === "roofer near me");
  assert.deepEqual(primary.expected.removed_from, []);
  assert.match(primary.changes.at(-1).after, /already listed/);
  const amb = rows.find((x) => x.label === "roofer in wentzville mo");
  assert.equal(amb.enabled, false);
  assert.equal(amb.links.length, 1);
  assert.match(amb.links[0].key, /^confirm_owner:/);
});

test("Lucas: record-content rows come from candidate_paths, and unmapped market keywords are blocked", () => {
  const r = runAuthority(lucasHomeInput());
  const o = r.opportunities.find((x) => x.key === "data_fix:record-live-blog-posts");
  if (o) {
    assert.ok(Array.isArray(o.candidate_paths));
    const rows = recordRows({ candidates: o.candidate_paths, prefix: "/blog/", pages: new Map(o.candidate_paths.map((p) => [p, { state: "live", title: p, url: p }])), recorded: new Set() });
    assert.deepEqual(rows.map((x) => x.id), o.candidate_paths);
  }
  const blocked = r.keywords.filter((k) => k.role === "unmapped" && k.flags.includes("location_unapproved"));
  for (const k of blocked) assert.ok(k.unapproved_places.length > 0, k.keyword);
});
