import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildOperationsV2, measurementFreshness } from "../src/lib/operations-readiness.ts";

const client = (id, name) => ({
  id, name, status: "active", keywordsTracked: 50, websites: 1,
  sitesMissingProject: 0, hasGsc: true, hasGa4: false, hasGbp: false,
  inReview: 1, published: 1, publicationProblems: 1,
  crmLite: "sms_off", alertsBlocked: 2, backlinkResearch: 4,
  backlinkActive: 0, publishingAccounts: 0, liveSubscriptions: 0, portalMembers: 0,
});
const mock = () => ({
  clients: [client("a","BHG Safety"), client("b","Ginger")],
  now: "2026-10-13T02:00:00Z",
  measured: [
    {client_id:"a",source:"Google Search Console property totals",window_end:"2026-09-30",created_at:"2026-10-12"},
    {client_id:"a",source:"Google Analytics 4",window_end:"2026-06-01",created_at:"2026-10-12"},
    {client_id:"b",source:"Google Search Console property totals",window_end:"2026-09-28",created_at:"2026-10-12"},
  ],
  brands: [
    {id:"safety",client_id:"a",status:"approved",blog_site_id:"site-1"},
    {id:"forklift",client_id:"a",status:"approved",blog_site_id:"site-2"},
  ],
  boards:[{client_id:"b",status:"approved"}],
  intake:[{client_id:"a",enabled:true}],
  drafts:[
    {id:"review",client_id:"a",status:"in_review",title:"Industrial hygiene",topic:null,
      request_task_id:"t1",created_at:"2026-10-12"},
    {id:"old",client_id:"b",status:"requested",title:null,topic:"OSHA Consultant",
      request_task_id:null,created_at:"2026-10-10"},
    {id:"new",client_id:"b",status:"requested",title:null,topic:"New request",
      request_task_id:null,created_at:"2026-10-13T01:30:00Z"},
  ],
  releases:[
    {id:"cancel",client_id:"a",draft_id:"review",status:"cancelled",last_error:"old failure",released_at:"2026-10-11"},
    {id:"published",client_id:"a",draft_id:"review",status:"published",last_error:null,released_at:"2026-10-12"},
    {id:"uncertain",client_id:"b",draft_id:"old",status:"uncertain",last_error:"Needs reconciliation",released_at:"2026-10-12"},
  ],
  sourceErrors:[],
});

test("freshness distinguishes latest observation window, stale, missing, and read failures", () => {
 const m=mock();
 assert.deepEqual(measurementFreshness(m.measured,"a","gsc",m.now),{
   state:"current",windowEnd:"2026-09-30",ageDays:13,
 });
 assert.equal(measurementFreshness(m.measured,"a","ga4",m.now).state,"stale");
 assert.equal(measurementFreshness(m.measured,"b","gbp",m.now).state,"missing");
 assert.equal(measurementFreshness(null,"b","gbp",m.now).state,"unknown");
 // A new import of an old window is still stale, never "current" simply because it arrived today.
 assert.equal(measurementFreshness(m.measured,"a","ga4",m.now).ageDays,134);
});
test("action queue preserves pending human approvals, stale source and unknown-release cautions", () => {
 const v=buildOperationsV2(mock());
 assert.equal(v.clients.length,2);
 assert.equal(v.clients[0].multiBrand,true);
 assert.equal(v.clients[0].readiness.find(x=>x.key==="brand").state,"recorded");
 assert.equal(v.clients[1].readiness.find(x=>x.key==="brand").state,"recorded");
 assert.ok(v.alerts.some(a=>a.title==="Publication needs reconciliation" && a.severity==="critical"));
 assert.ok(v.alerts.some(a=>a.title==="Article waiting for approval" && a.href.endsWith("/drafts/review")));
 assert.ok(v.alerts.some(a=>a.title==="Draft request has no worker task" && a.href.endsWith("/drafts/old")));
 assert.ok(v.alerts.some(a=>a.title==="GA4 measurement window is old"));
 assert.ok(v.alerts.some(a=>a.title==="SMS inquiry alerts disabled" && a.severity==="setup"));
 assert.ok(v.alerts.some(a=>a.title==="Multiple brands share one parent client"));
 assert.ok(!v.alerts.some(a=>a.id.endsWith("new")), "New requests should not be stale");
 assert.ok(!v.alerts.some(a=>a.id.includes("cancel")), "Cancelled releases are only audit history");
 assert.ok(!v.alerts.some(a=>a.id.includes("published")), "Published releases do not require reconciliation");
});
test("onboarding evidence avoids inventing connection health, business scope or billing",()=>{
 const m=mock();m.measured=null;m.brands=null;m.boards=null;m.intake=null;
 const v=buildOperationsV2(m);
 assert.equal(v.clients[0].freshness.gsc.state,"unknown");
 assert.equal(v.clients[0].readiness.find(x=>x.key==="brand").state,"unknown");
 assert.equal(v.clients[0].readiness.find(x=>x.key==="intake").state,"unknown");
 assert.equal(v.clients[0].readiness.find(x=>x.key==="billing").state,"missing");
 assert.equal(v.clients[0].readiness.find(x=>x.key==="portal").state,"missing");
 assert.equal(v.clients[0].readiness.find(x=>x.key==="website").state,"recorded");
 assert.equal(v.alerts.some(a=>a.title.includes("measurement window is old")),false);
});
test("Control Center 2.0 is interactive but read-only, with source-aware server reads",()=>{
 const p=readFileSync("src/app/(app)/production/health/page.tsx","utf8");
 const ui=readFileSync("src/components/operations/control-center-v2.tsx","utf8");
 const model=readFileSync("src/lib/operations-readiness.ts","utf8");
 assert.match(p,/buildOperationsV2/);
 assert.match(p,/report_measurements/);
 assert.match(p,/data-operations-health/);
 assert.match(ui,/data-control-center-v2/);
 assert.match(ui,/data-action-list/);
 assert.match(ui,/data-readiness-client/);
 assert.match(ui,/data-freshness-client/);
 assert.match(ui,/Filter clients/);
 assert.match(model,/MEASUREMENT_MAX_AGE_DAYS = 45/);
 for(const src of [p,ui]) {
   assert.doesNotMatch(src,/\.insert\(|\.update\(|\.delete\(|\.rpc\(/,
     "Health view must not send, publish, bill or mutate clients");
 }
});
test("integration failures drive linked alerts and onboarding; recovery removes current incident",()=>{
 const m=mock();m.integrations=[{clientId:'a',source:'ga4',state:'partial',evidence:'One period failed',nextAction:'Review reporting',href:'/clients/a/growth'}];
 let v=buildOperationsV2(m);
 assert.equal(v.clients[0].readiness.find(c=>c.key==='analytics').state,'blocked');
 assert.ok(v.alerts.some(a=>a.id==='a:integration:ga4'&&a.href==='/clients/a/growth'));
 assert.equal(v.clients[1].readiness.find(c=>c.key==='analytics').state,'unknown');
 m.integrations[0].state='verified';v=buildOperationsV2(m);
 assert.equal(v.clients[0].readiness.find(c=>c.key==='analytics').state,'recorded');
 assert.ok(!v.alerts.some(a=>a.id==='a:integration:ga4'));
 m.integrations[0].state='waiting';v=buildOperationsV2(m);assert.equal(v.clients[0].readiness.find(c=>c.key==='analytics').state,'waiting');assert.equal(v.alerts.find(a=>a.id==='a:integration:ga4').severity,'setup');
 m.integrations[0].state='running';v=buildOperationsV2(m);
 assert.equal(v.clients[0].readiness.find(c=>c.key==='analytics').state,'waiting');
});
test('future scheduled blog releases and superseded failures do not create active incidents',()=>{
 const m=mock();m.releases=[{id:'old',client_id:'a',draft_id:'draft',draft_version:1,status:'blocked',released_at:'2026-10-01',last_error:'old error'},{id:'new',client_id:'a',draft_id:'draft',draft_version:2,status:'published',released_at:'2026-10-10'},{id:'future',client_id:'a',draft_id:'other',draft_version:1,status:'queued',released_at:'2026-10-01',scheduled_at:'2027-01-01'}];
 const v=buildOperationsV2(m);assert.ok(!v.alerts.some(a=>a.id==='a:release:old'||a.id==='a:queued:future'));
});

test("a weekly Maps grid with no successful scan for its week becomes a linked action", () => {
  const missed = { state: "missed", week: "2026-W42", severity: "critical", title: "Weekly scan failed to start (2026-W42)",
    detail: "Grid keyword mismatch", lastSuccessAt: "2026-10-08T14:00:05Z", attempt: null };
  const ok = { ...missed, state: "ok", severity: null, title: "Weekly scan complete for 2026-W42" };
  const v2 = buildOperationsV2({ ...mock(), mapGrid: [
    { clientId: "a", clientName: "BHG Safety", profileId: "p1", label: "Lucas 1/2/5 mi", status: missed },
    { clientId: "b", clientName: "Ginger", profileId: "p2", label: "Ginger", status: ok },
  ] });
  const grid = v2.alerts.filter((a) => a.id.includes(":map-grid:"));
  assert.equal(grid.length, 1);
  assert.equal(grid[0].severity, "critical");
  // The link opens the exact grid, not just the client's first one.
  assert.equal(grid[0].href, "/clients/a/maps?profile=p1");
  assert.match(grid[0].title, /Lucas 1\/2\/5 mi/);
  assert.match(grid[0].detail, /Grid keyword mismatch/);
  assert.equal(v2.mapGrid.length, 2);
});

test("a map-tracking-only client outside the full-service roster still gets its missed-scan alert, and nothing else", () => {
  const missed = { state: "missed", week: "2026-W42", severity: "critical", title: "Weekly scan did not start (2026-W42)",
    detail: "No weekly start was recorded for 2026-W42.", lastSuccessAt: null, attempt: null };
  const base = buildOperationsV2(mock());
  const v2 = buildOperationsV2({ ...mock(), mapGrid: [
    { clientId: "paused", clientName: "Silverback Plumbing", profileId: "sb", label: "Silverback 1/2/5 mi", status: missed },
  ] });
  const grid = v2.alerts.filter((a) => a.clientId === "paused");
  assert.equal(grid.length, 1);
  assert.equal(grid[0].clientName, "Silverback Plumbing");
  assert.equal(grid[0].href, "/clients/paused/maps?profile=sb");
  // No roster entry, readiness checks or other warnings are invented for it.
  assert.equal(v2.clients.some((c) => c.id === "paused"), false);
  assert.equal(v2.alerts.length, base.alerts.length + 1);
});
