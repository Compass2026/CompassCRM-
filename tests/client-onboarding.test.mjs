// New Client Onboarding pure helpers (src/lib/client-onboarding.ts) and the
// Control Center check. Fictional fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { summarize, waitingOn, signalText, prepareUpdate, readinessState, statusOptions, isDone } from "../src/lib/client-onboarding.ts";
import { buildOperationalEvidence } from "../src/lib/operations-evidence.ts";

let seq = 0;
const row = (o) => ({
  id: `r${++seq}`, client_id: "a", site_id: null, location_id: null, status: "not_started", required: true, owner: "TOM", due_on: null,
  evidence_url: null, evidence_note: "", blocking_reason: "", next_action: "", last_verified_at: null, verified_by: null, updated_at: "2026-10-29",
  section: "identity", scope: "client", title: o.item_key, guidance: "", depends_on: [], evidence_source: null, citation_directory_key: null,
  pipeline_task_key: null, sort_order: 1, standard_version: "1.0", item_active: true, scope_label: null, location_hide_address: null,
  pipeline_task_id: null, pipeline_task_status: null, pipeline_task_title: null, signal: null, ...o,
});

test("summary: verified and reasoned not-applicable count as done; connected does not; optional and retired items are not counted", () => {
  const rows = [
    row({ item_key: "a", status: "verified" }),
    row({ item_key: "b", status: "not_applicable", evidence_note: "No storefront" }),
    row({ item_key: "c", status: "connected", evidence_note: "Zernio bound" }),
    row({ item_key: "d", status: "blocked", blocking_reason: "Owner has not granted GBP access", section: "search" }),
    row({ item_key: "e", status: "needs_correction", next_action: "Fix Yelp phone", section: "citations" }),
    row({ item_key: "f", due_on: "2026-10-01" }),
    row({ item_key: "g", required: false }),
    row({ item_key: "h", item_active: false }),
  ];
  const s = summarize(rows, "2026-10-29");
  assert.equal(s.total, 6);
  assert.equal(s.done, 2);
  assert.deepEqual(s.outstanding.map((o) => [o.row.item_key, o.kind]), [["d", "blocked"], ["e", "correction"], ["f", "overdue"]]);
  assert.deepEqual(s.bySection.identity, { total: 4, done: 2 });
  assert.equal(isDone(row({ item_key: "x", status: "connected" })), false);
  assert.equal(summarize([], "2026-10-29").enrolled, false);
});

test("dependencies are judged in the same site / location; another client's rows never satisfy them", () => {
  const rows = [
    row({ item_key: "identity_location", scope: "location", location_id: "L1", status: "verified" }),
    row({ item_key: "identity_location", scope: "location", location_id: "L2" }),
    row({ item_key: "identity_location", scope: "location", location_id: "L1", client_id: "b", status: "verified" }),
  ];
  const yelp1 = row({ item_key: "citation_yelp", scope: "location", location_id: "L1", depends_on: ["identity_location"] });
  const yelp2 = row({ item_key: "citation_yelp", scope: "location", location_id: "L2", depends_on: ["identity_location"] });
  assert.equal(waitingOn(yelp1, rows).length, 0);
  assert.deepEqual(waitingOn(yelp2, rows).map((r) => r.location_id), ["L2"]);
  const otherClient = row({ item_key: "citation_yelp", client_id: "c", scope: "location", location_id: "L1", depends_on: ["identity_location"] });
  assert.equal(waitingOn(otherClient, rows).length, 0, "no row for client c: nothing to wait on is reported, not someone else's");
  // A client-scoped dependency is shared by every site.
  const shared = [row({ item_key: "access_requests" })];
  assert.equal(waitingOn(row({ item_key: "gsc_verified", scope: "site", site_id: "S1", depends_on: ["access_requests"] }), shared).length, 1);
});

test("signals describe records, never claim verification, and say an empty listing search is not absence", () => {
  assert.match(signalText({ evidence_source: "citation", signal: { listings: 0 } }), /not proof it does not exist/);
  assert.equal(signalText({ evidence_source: "citation", signal: { listings: 2, verified: 1, discrepancy: 1, open_tasks: 1, last_checked_on: "2026-10-20" } }),
    "2 listings · 1 verified accurate · 1 need correction / reverification · 1 open citation tasks · last checked 2026-10-20.");
  assert.equal(signalText({ evidence_source: "gsc", signal: { property: "", data_through: null } }), "No Search Console property on the client.");
  assert.equal(signalText({ evidence_source: "gsc", signal: { property: "sc-domain:example.test", data_through: null } }), "sc-domain:example.test · no import yet.");
  assert.match(signalText({ evidence_source: "ga4", signal: { property: "properties/1", measurement_id: "", data_through: null } }), /no measurement id/);
  assert.match(signalText({ evidence_source: "facebook_binding", signal: { bound: 1, verified: 1, enabled: 0 } }), /0 publishing enabled/);
  assert.match(signalText({ evidence_source: "website_pipeline", signal: { work_mode: "upgrade_existing", pipeline_status: "active", launched_at: null } }), /not launched/);
});

test("updates: evidence rules, listing-only states, no credentials", () => {
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
  assert.deepEqual(statusOptions({ citation_directory_key: null }).includes("claimed"), false);
  assert.deepEqual(statusOptions({ citation_directory_key: "yelp" }).includes("claimed"), true);
});

test("Control Center check: missing until started, blocked on blockers, recorded only when every required item is done", () => {
  assert.equal(readinessState(null, "2026-10-29").state, "unknown");
  assert.equal(readinessState([], "2026-10-29").state, "missing");
  assert.equal(readinessState([row({ item_key: "a", status: "verified" }), row({ item_key: "b" })], "2026-10-29").state, "waiting");
  assert.equal(readinessState([row({ item_key: "a", status: "blocked", blocking_reason: "x" })], "2026-10-29").state, "blocked");
  assert.equal(readinessState([row({ item_key: "a", status: "verified" }), row({ item_key: "b", status: "not_applicable", evidence_note: "x" })], "2026-10-29").state, "recorded");

  const input = { clients: [{ id: "a", name: "A", website_url: null }, { id: "b", name: "B", website_url: null }], keywords: [], rankings: [], rankRuns: [], backlinks: [], backlinkChecks: [], backlinkRuns: [],
    profileMeasures: [], socialAccounts: [], social: [], notifications: [], billing: [], sites: [], brands: [], services: [], claims: [], authority: [], now: "2026-10-29T15:00:00Z" };
  assert.ok(!buildOperationalEvidence(input).checks.a.some((c) => c.key === "onboarding"), "not loaded: no check");
  const out = buildOperationalEvidence({ ...input, onboarding: [row({ item_key: "a", status: "verified" })] });
  assert.equal(out.checks.a.find((c) => c.key === "onboarding").state, "recorded");
  assert.equal(out.checks.a.find((c) => c.key === "onboarding").href, "/clients/a/onboarding");
  assert.equal(out.checks.b.find((c) => c.key === "onboarding").state, "missing", "client b is judged on its own rows only");
});

test("migration: no client is enrolled, nothing is applied remotely from it, and the trigger is gated on full service", () => {
  const sql = readFileSync("supabase/migrations/20261029170000_client_onboarding_checklist.sql", "utf8");
  assert.doesNotMatch(sql, /perform\s+public\.enroll_client_onboarding\(\s*c\.id|select\s+public\.enroll_client_onboarding\(/i);
  assert.match(sql, /clients_zz_onboarding_checklist after insert on public\.clients\s+for each row when \(new\.service_scope = 'full'\)/);
  assert.doesNotMatch(sql, /net\.http_post|fire_foundation_worker/);
});
