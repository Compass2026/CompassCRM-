// New Client Onboarding pure helpers (src/lib/client-onboarding.ts) and the
// Control Center check. Fictional fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { summarize, prerequisites, unmet, isComplete, signalText, prepareUpdate, readinessState, statusOptions, isDone } from "../src/lib/client-onboarding.ts";
import { buildOperationalEvidence } from "../src/lib/operations-evidence.ts";

let seq = 0;
const row = (o) => ({
  id: `r${++seq}`, client_id: "a", site_id: null, location_id: null, social_account_id: null, status: "not_started", required: true, owner: "TOM", due_on: null,
  evidence_url: null, evidence_note: "", blocking_reason: "", next_action: "", last_verified_at: null, verified_by: null, updated_at: "2026-10-29",
  section: "identity", scope: "client", title: o.item_key, guidance: "", depends_on: [], evidence_source: null, citation_directory_key: null,
  pipeline_task_key: null, sort_order: 1, standard_version: "1.0", item_active: true, scope_label: null, location_hide_address: null,
  location_status: null, client_service_scope: "full", pipeline_task_id: null, pipeline_task_status: null, pipeline_task_title: null, signal: null, ...o,
});
const gap = (kind, o = {}) => ({ client_id: "a", kind, target_id: null, label: null, detail: `${kind} detail`, ...o });

test("summary: verified and reasoned not-applicable count; connected does not; optional, retired and archived-location rows are not counted", () => {
  const rows = [
    row({ item_key: "a", status: "verified" }),
    row({ item_key: "b", status: "not_applicable", evidence_note: "No storefront" }),
    row({ item_key: "c", status: "connected", evidence_note: "Zernio bound" }),
    row({ item_key: "d", status: "blocked", blocking_reason: "Owner has not granted GBP access", section: "search" }),
    row({ item_key: "e", status: "needs_correction", next_action: "Fix Yelp phone", section: "citations" }),
    row({ item_key: "f", due_on: "2026-10-01" }),
    row({ item_key: "g", required: false }),
    row({ item_key: "h", item_active: false }),
    row({ item_key: "i", scope: "location", location_id: "L9", location_status: "archived" }),
  ];
  const s = summarize(rows, [], "2026-10-29");
  assert.equal(s.total, 6);
  assert.equal(s.done, 2);
  assert.equal(s.complete, false);
  assert.deepEqual(s.outstanding.map((o) => [o.row.item_key, o.kind]), [["d", "blocked"], ["e", "correction"], ["f", "overdue"]]);
  assert.deepEqual(s.bySection.identity, { total: 4, done: 2 });
  assert.equal(isDone(row({ item_key: "x", status: "connected" })), false);
  assert.equal(summarize([], [], "2026-10-29").enrolled, false);
});

test("no false green: every item done is still incomplete while a scope gap is open", () => {
  const rows = [row({ item_key: "identity_business", status: "verified" }), row({ item_key: "scope_sites", status: "verified" })];
  const open = summarize(rows, [gap("no_location")], "2026-10-29");
  assert.equal(open.done, open.total);
  assert.equal(open.complete, false, "a client with no location decided is not complete");
  assert.deepEqual(open.outstanding.map((o) => o.kind), ["gap"]);
  assert.equal(readinessState(rows, [gap("no_location")], "2026-10-29").state, "blocked");
  assert.match(readinessState(rows, [gap("no_location")], "2026-10-29").detail, /1 scope gap/);
  assert.equal(readinessState(rows, [], "2026-10-29").state, "recorded");
  for (const k of ["no_site", "site_after_none", "location_after_none", "site_missing_items", "location_missing_items"])
    assert.equal(summarize(rows, [gap(k)], "2026-10-29").complete, false, k);
});

test("prerequisites are judged in the exact site / location; missing is never satisfied; no fallback to another scope", () => {
  const rows = [
    row({ item_key: "identity_location", title: "Location identity", scope: "location", location_id: "L1", status: "verified" }),
    row({ item_key: "identity_location", title: "Location identity", scope: "location", location_id: "L2" }),
    row({ item_key: "identity_location", title: "Location identity", scope: "location", location_id: "L3", client_id: "b", status: "verified" }),
    row({ item_key: "website_owner", title: "Website owner", scope: "site", site_id: "S1", status: "verified" }),
  ];
  const yelp = (loc, o = {}) => row({ item_key: "citation_yelp", scope: "location", location_id: loc, depends_on: ["identity_location"], ...o });
  assert.deepEqual(unmet(yelp("L1"), rows), []);
  assert.deepEqual(unmet(yelp("L2"), rows).map((p) => [p.missing, p.row.location_id]), [[false, "L2"]]);
  // L3 has a done row, but for client b: client a's L3 row is missing, not satisfied.
  assert.deepEqual(unmet(yelp("L3"), rows).map((p) => [p.key, p.missing, p.title]), [["identity_location", true, "Location identity"]]);
  // A second site never borrows the first site's done row.
  const gsc2 = row({ item_key: "gsc_verified", scope: "site", site_id: "S2", depends_on: ["website_owner"] });
  assert.equal(prerequisites(gsc2, rows)[0].missing, true);
  // A client-scoped dependency is the client's row.
  assert.equal(unmet(row({ item_key: "gsc_verified", scope: "site", site_id: "S1", depends_on: ["access_requests"] }), [row({ item_key: "access_requests" })]).length, 1);
  // Missing and reopened prerequisites are reported; reasoned not-applicable needs none.
  const s = summarize([...rows, yelp("L3"), yelp("L2", { status: "verified", evidence_note: "x" }), yelp("L1", { status: "verified", evidence_note: "x" }),
    row({ item_key: "citation_bbb", scope: "location", location_id: "L2", depends_on: ["identity_location"], status: "not_applicable", evidence_note: "No free listing" })], [], "2026-10-29");
  assert.deepEqual(s.outstanding.map((o) => o.kind).sort(), ["missing_prerequisite", "reopened_prerequisite"]);
  assert.equal(isComplete(yelp("L2", { status: "verified" }), rows), false);
  assert.equal(isComplete(row({ item_key: "citation_bbb", scope: "location", location_id: "L2", depends_on: ["identity_location"], status: "not_applicable" }), rows), true);
});

test("signals describe records, label client-wide counts, and say an empty listing search is not absence", () => {
  assert.match(signalText({ evidence_source: "citation", signal: { listings: 0 } }), /not proof it does not exist/);
  assert.equal(signalText({ evidence_source: "citation", signal: { listings: 2, verified: 1, discrepancy: 1, open_tasks: 1, last_checked_on: "2026-10-20" } }),
    "2 listings · 1 verified accurate · 1 need correction / reverification · 1 open citation tasks · last checked 2026-10-20.");
  assert.match(signalText({ evidence_source: "gsc", signal: { scope: "exact", host: null } }), /no live URL/);
  assert.equal(signalText({ evidence_source: "gsc", signal: { scope: "exact", host: "a.example.test", property: null, client_property: "sc-domain:other.example.test" } }),
    "No Search Console import for a.example.test yet. Client-wide property sc-domain:other.example.test is not evidence for this site.");
  assert.equal(signalText({ evidence_source: "gsc", signal: { scope: "exact", host: "a.example.test", property: "sc-domain:a.example.test", data_through: "2026-09-30" } }),
    "sc-domain:a.example.test · data through 2026-09-30.");
  assert.match(signalText({ evidence_source: "ga4", signal: { scope: "exact", host: "a.example.test", measurement_id: "", property: null } }), /no measurement id .* no GA4 import filtered to a\.example\.test/);
  assert.match(signalText({ evidence_source: "gbp_binding", signal: { scope: "unlinked", bound: 1, verified: 1 } }), /No Business Profile named for this location.*not evidence for this location/);
  assert.match(signalText({ evidence_source: "gbp_binding", signal: { scope: "exact", account: "locations/2", name: "Overland Park", provider: "" } }), /not connected through Zernio/);
  assert.match(signalText({ evidence_source: "facebook_binding", signal: { scope: "unlinked", bound: 2, verified: 2, expected_account: "x" } }), /brand has its own Page.*not evidence for this site/);
  assert.match(signalText({ evidence_source: "website_pipeline", signal: { work_mode: "upgrade_existing", pipeline_status: "active", launched_at: null } }), /not launched/);
  assert.match(signalText({ evidence_source: "scope", item_key: "scope_locations", signal: { records: 0 } }), /0 approved business locations/);
});

test("updates: evidence rules, listing-only states, account items, no credentials", () => {
  const base = { status: "verified", evidence_url: "", evidence_note: "", blocking_reason: "", next_action: "", due_on: "", required: true, listing: false };
  assert.throws(() => prepareUpdate(base), /needs evidence/);
  assert.equal(prepareUpdate({ ...base, evidence_note: "Property shows data through Oct 27" }).status, "verified");
  assert.throws(() => prepareUpdate({ ...base, status: "claimed", evidence_note: "x" }), /listing states/);
  assert.equal(prepareUpdate({ ...base, status: "claimed", evidence_note: "x", listing: true }).status, "claimed");
  assert.throws(() => prepareUpdate({ ...base, status: "not_applicable" }), /does not apply/);
  assert.throws(() => prepareUpdate({ ...base, status: "blocked" }), /blocking/);
  assert.throws(() => prepareUpdate({ ...base, status: "needs_correction" }), /next action/);
  assert.throws(() => prepareUpdate({ ...base, evidence_note: "login password: hunter2" }), /secret/);
  assert.throws(() => prepareUpdate({ ...base, evidence_url: "https://user:pw@example.test/x" }), /without credentials/);
  assert.throws(() => prepareUpdate({ ...base, status: "made_up" }), /Choose a status/);
  assert.throws(() => prepareUpdate({ ...base, evidence_note: "x", account: "0b600000-0000-4000-e000-0000000000a1" }), /Only Business Profile and Facebook/);
  const acct = prepareUpdate({ ...base, evidence_note: "x", accountItem: true, account: "0b600000-0000-4000-e000-0000000000a1" });
  assert.equal(acct.social_account_id, "0b600000-0000-4000-e000-0000000000a1");
  assert.equal(prepareUpdate({ ...base, evidence_note: "x", accountItem: true, account: null }).social_account_id, null);
  assert.throws(() => prepareUpdate({ ...base, evidence_note: "x", accountItem: true, account: "not-an-id" }), /from the list/);
  assert.equal(statusOptions({ citation_directory_key: null }).includes("claimed"), false);
  assert.equal(statusOptions({ citation_directory_key: "yelp" }).includes("claimed"), true);
});

test("Control Center check: missing until started, blocked on gaps or blockers, recorded only when complete; each client on its own rows", () => {
  assert.equal(readinessState(null, [], "2026-10-29").state, "unknown");
  assert.equal(readinessState([], null, "2026-10-29").state, "unknown");
  assert.equal(readinessState([], [], "2026-10-29").state, "missing");
  assert.equal(readinessState([row({ item_key: "a", status: "verified" }), row({ item_key: "b" })], [], "2026-10-29").state, "waiting");
  assert.equal(readinessState([row({ item_key: "a", status: "blocked", blocking_reason: "x" })], [], "2026-10-29").state, "blocked");

  const input = { clients: [{ id: "a", name: "A", website_url: null }, { id: "b", name: "B", website_url: null }], keywords: [], rankings: [], rankRuns: [], backlinks: [], backlinkChecks: [], backlinkRuns: [],
    profileMeasures: [], socialAccounts: [], social: [], notifications: [], billing: [], sites: [], brands: [], services: [], claims: [], authority: [], now: "2026-10-29T15:00:00Z" };
  assert.ok(!buildOperationalEvidence(input).checks.a.some((c) => c.key === "onboarding"), "not loaded: no check");
  const done = [row({ item_key: "a", status: "verified" })];
  const out = buildOperationalEvidence({ ...input, onboarding: done, onboardingGaps: [] });
  assert.equal(out.checks.a.find((c) => c.key === "onboarding").state, "recorded");
  assert.equal(out.checks.a.find((c) => c.key === "onboarding").href, "/clients/a/onboarding");
  assert.equal(out.checks.b.find((c) => c.key === "onboarding").state, "missing", "client b is judged on its own rows only");
  assert.equal(buildOperationalEvidence({ ...input, onboarding: done, onboardingGaps: [gap("no_site")] }).checks.a.find((c) => c.key === "onboarding").state, "blocked");
  assert.equal(buildOperationalEvidence({ ...input, onboarding: done, onboardingGaps: [gap("no_site", { client_id: "b" })] }).checks.a.find((c) => c.key === "onboarding").state, "recorded");
  assert.equal(buildOperationalEvidence({ ...input, onboarding: done, onboardingGaps: null }).checks.a.find((c) => c.key === "onboarding").state, "unknown");
});

test("migration: no client enrolled, no existing task rewritten, gated on full service, dependencies stay in scope", () => {
  const sql = readFileSync("supabase/migrations/20261029170000_client_onboarding_checklist.sql", "utf8");
  assert.doesNotMatch(sql, /perform\s+public\.enroll_client_onboarding\(\s*c\.id|select\s+public\.enroll_client_onboarding\(/i);
  assert.doesNotMatch(sql, /update\s+public\.tasks\b/i, "existing tasks are relabelled only by the deferred, reviewed script");
  assert.match(sql, /clients_zz_onboarding_checklist after insert on public\.clients\s+for each row when \(new\.service_scope = 'full'\)/);
  assert.match(sql, /onboarding dependency is unknown or crosses scopes/);
  assert.doesNotMatch(sql, /net\.http_post|fire_foundation_worker/);
  assert.match(readFileSync("supabase/deferred/20261029_legacy_task_labels.sql", "utf8"), /compass\.expected_legacy_tasks/);
});
