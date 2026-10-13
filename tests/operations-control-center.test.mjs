import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildOperationsHealth } from "../src/lib/operations-health.ts";

const fixture = () => ({
  clients: [
    { id: "a", name: "Alpha", status: "active" },
    { id: "b", name: "Beta", status: "launching" },
    { id: "x", name: "Demo", status: "offboarded" },
  ],
  keywords: [
    { client_id: "a", is_active: true, is_tracked: true },
    { client_id: "a", is_active: false, is_tracked: true },
    { client_id: "b", is_active: true, is_tracked: false },
  ],
  sites: [
    { client_id: "a", controlled_by_compass: true, vercel_project: "alpha" },
    { client_id: "b", controlled_by_compass: true, vercel_project: null },
  ],
  gsc: [{ client_id: "a" }],
  ga4: [],
  gbp: [{ client_id: "b" }],
  drafts: [
    { client_id: "a", status: "approved" },
    { client_id: "a", status: "in_review" },
    { client_id: "b", status: "requested" },
  ],
  publications: [
    { id: "p1", client_id: "a", status: "published" },
    { id: "p2", client_id: "a", status: "cancelled" },
    { id: "p3", client_id: "b", status: "blocked" },
    { id: "p4", client_id: "b", status: "uncertain" },
  ],
  lite: [{ client_id: "a", enabled: true, sms_alerts_enabled: false }],
  notifications: [{ client_id: "a", status: "blocked", block_reason: "sms_alerts_off" }],
  backlinks: [
    { client_id: "a", stage: "research" },
    { client_id: "a", stage: "outreach" },
  ],
  social: [{ client_id: "a", publish_enabled: true }],
  subscriptions: [
    { client_id: "a", livemode: false, status: "active" },
    { client_id: "b", livemode: true, status: "active" },
  ],
  portal: [],
});

test("Operations Control Center counts only current clients and verified blog releases", () => {
  const r = buildOperationsHealth(fixture());
  assert.equal(r.counts.clients, 2);
  assert.equal(r.counts.trackedKeywords, 1);
  assert.equal(r.counts.published, 1, "approved drafts and cancelled releases never imply publication");
  assert.equal(r.counts.inReview, 1);
  assert.equal(r.counts.publicationProblems, 2, "blocked and uncertain releases remain visible");
  assert.equal(r.counts.alertsBlocked, 1);
  assert.equal(r.counts.liveSubscriptions, 1, "TEST subscriptions do not count as live billing");
  assert.deepEqual(r.coverage, { gsc: 1, ga4: 0, gbp: 1 });
  assert.equal(r.clients[0].crmLite, "sms_off", "a captured inquiry does not imply live SMS");
  assert.equal(r.clients[0].backlinkResearch, 1);
  assert.equal(r.clients[0].backlinkActive, 1);
  assert.equal(r.clients[0].websites, 1);
  assert.equal(r.clients[1].sitesMissingProject, 1);
  assert.equal(r.clients[1].crmLite, "not_enabled");
});

test("A failed data-source read is unknown, never a healthy zero", () => {
  const input = fixture();
  input.ga4 = null;
  input.publications = null;
  input.notifications = null;
  input.subscriptions = null;
  const r = buildOperationsHealth(input);
  assert.equal(r.coverage.ga4, null);
  assert.equal(r.counts.published, null);
  assert.equal(r.counts.publicationProblems, null);
  assert.equal(r.counts.alertsBlocked, null);
  assert.equal(r.counts.liveSubscriptions, null);
  assert.equal(r.clients[0].hasGa4, null);
  assert.equal(r.clients[1].hasGa4, null);
  assert.equal(r.clients[0].liveSubscriptions, null);
});
test("The health route is read-only, team-gated and accessible from navigation", () => {
  const route = readFileSync("src/app/(app)/production/health/page.tsx", "utf8");
  const nav = readFileSync("src/components/app-nav.tsx", "utf8");
  const auth = readFileSync("src/app/(app)/layout.tsx", "utf8");
  assert.match(route, /createClient\(/);
  assert.match(route, /data-operations-health/);
  assert.match(route, /data-health-client/);
  assert.match(route, /Partial visibility/);
  assert.match(route, /Not recorded/);
  assert.match(route, /LIVE subscriptions in CRM/);
  assert.match(route, /human|read-only/i);
  assert.doesNotMatch(route, /\.insert\(|\.update\(|\.delete\(|\.rpc\(/, "No mutations or worker RPCs in the Control Center");
  assert.match(nav, /\/production\/health/);
  assert.match(auth, /team_members/);
  assert.match(auth, /redirect\("\/login"\)/);
});
