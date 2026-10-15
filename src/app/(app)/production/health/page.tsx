import { loadRolloutReviews } from "@/lib/agency-rollout-loader";
import Link from "next/link";
import { Activity, ArrowRight, ChartNoAxesCombined, CircleAlert, Database, Layers3, ShieldCheck, Workflow } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { buildOperationsHealth, type HealthInputs, type ClientHealth } from "@/lib/operations-health";
import { loadOperationalEvidence } from "@/lib/operations-evidence-loader";
import { loadIntegrationHealth } from "@/lib/integration-health-loader";
import { loadMapGridWeekly } from "@/lib/map-grid-weekly-loader";
import { completeRead } from "@/lib/integration-health";
import { buildOperationsV2 } from "@/lib/operations-readiness";
import { ControlCenterV2 } from "@/components/operations/control-center-v2";

export const dynamic = "force-dynamic";

const display = (n: number | null): string => n === null ? "Unavailable" : n.toLocaleString("en-US");
const statusColor = (active: boolean | null): string =>
  active === null ? "bg-slate-100 text-slate-500" : active ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800";

function DataStatus({ available }: { available: boolean | null }) {
  return <span className={"inline-flex rounded-full px-2 py-1 text-[11px] font-medium " + statusColor(available)}>
    {available === null ? "Unknown" : available ? "Recorded" : "Not recorded"}
  </span>;
}
function HealthNumber({ value }: { value: number | null }) {
  return <span className={value === null ? "text-slate-400" : "text-navy-900"}>{display(value)}</span>;
}
function LayerTile({ number, title, value, label, href }: {
  number: number; title: string; value: string; label: string; href: string;
}) {
  return <Link href={href} className="group rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-blue-200 hover:shadow-md">
    <span className="text-[10px] font-bold uppercase tracking-[.16em] text-slate-500">Layer {number}</span>
    <p className="mt-2 text-sm font-semibold text-navy-900">{title}</p>
    <p className="mt-3 text-2xl font-semibold tabular-nums text-navy-900">{value}</p>
    <span className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-500">{label}<ArrowRight className="size-4 shrink-0 text-orange-600 transition group-hover:translate-x-0.5" /></span>
  </Link>;
}
function PriorityItem({ title, detail, href, tone = "amber" }: {
  title: string; detail: string; href: string; tone?: "amber" | "blue";
}) {
  return <Link href={href} className="block rounded-xl border border-slate-200 bg-white px-4 py-3 transition hover:border-blue-300">
    <span className={"text-xs font-semibold " + (tone === "amber" ? "text-amber-800" : "text-blue-800")}>{title}</span>
    <p className="mt-1 text-xs leading-relaxed text-slate-600">{detail}</p>
  </Link>;
}
function ClientRow({ client }: { client: ClientHealth }) {
  return <tr className="border-b border-slate-100 align-top last:border-0" data-health-client={client.id}>
    <td className="p-3">
      <Link href={"/clients/" + client.id + "/growth"} className="font-semibold text-navy-900 hover:underline">{client.name}</Link>
      <span className="mt-0.5 block text-[11px] capitalize text-slate-500">{client.status}</span>
    </td>
    <td className="p-3 tabular-nums"><HealthNumber value={client.keywordsTracked}/></td>
    <td className="p-3">
      <div className="flex flex-col items-start gap-1">
        <span className="text-[11px] text-slate-500">GSC <DataStatus available={client.hasGsc}/></span>
        <span className="text-[11px] text-slate-500">GA4 <DataStatus available={client.hasGa4}/></span>
        <span className="text-[11px] text-slate-500">GBP <DataStatus available={client.hasGbp}/></span>
      </div>
    </td>
    <td className="p-3 text-xs leading-6 text-slate-700">
      <p><HealthNumber value={client.published}/> verified publications</p>
      <p><HealthNumber value={client.inReview}/> in review</p>
      {client.publicationProblems !== null && client.publicationProblems > 0 &&
        <p className="font-semibold text-red-700">{client.publicationProblems} blocked / uncertain</p>}
      {client.publicationProblems === null && <p className="text-slate-500">Publisher status unavailable</p>}
    </td>
    <td className="p-3 text-xs">
      <span className={client.crmLite === "sms_off" ? "font-semibold text-amber-800" : "text-slate-600"}>
        {client.crmLite === "sms_enabled" ? "SMS enabled" : client.crmLite === "sms_off" ? "SMS not enabled" :
          client.crmLite === "not_enabled" ? "Not activated" : "Unknown"}
      </span>
      <p className="mt-1 text-slate-500"><HealthNumber value={client.alertsBlocked}/> blocked alerts</p>
    </td>
    <td className="p-3 text-xs text-slate-700">
      <p><HealthNumber value={client.backlinkResearch}/> researching</p>
      <p><HealthNumber value={client.backlinkActive}/> progressed</p>
      <p className="text-slate-500">Progress is not a verified placement</p>
    </td>
    <td className="p-3 text-xs text-slate-700">
      <p><HealthNumber value={client.liveSubscriptions}/> LIVE subscriptions in CRM</p>
      <p className="text-slate-500">External billing not inferred</p>
    </td>
  </tr>;
}

export default async function OperationsHealthPage() {
  // Team authorization lives in the app layout and every read uses user RLS.
  const db = await createClient();
  const [
    clientsQ, keywordsQ, sitesQ, gscQ, ga4Q, gbpQ, draftsQ,
    publicationsQ, liteQ, notificationsQ, backlinksQ, socialQ,
    subscriptionsQ, portalQ, measuredQ, brandsQ, boardsQ, intakeQ, detailedDraftsQ, detailedReleasesQ,
  ] = await Promise.all([
    db.from("clients").select("id,name,status", {count:"exact"}).in("status", ["active", "launching"]).order("name"),
    db.from("keywords").select("client_id,is_active,is_tracked", {count:"exact"}).limit(3000),
    db.from("sites").select("client_id,controlled_by_compass,vercel_project", {count:"exact"}).limit(1000),
    db.from("report_measurements").select("client_id", {count:"exact"}).eq("status", "measured").eq("source", "Google Search Console property totals").limit(3000),
    db.from("report_measurements").select("client_id", {count:"exact"}).eq("status", "measured").eq("source", "Google Analytics 4").limit(3000),
    db.from("report_measurements").select("client_id", {count:"exact"}).eq("status", "measured").eq("source", "Google Business Profile via Zernio").limit(3000),
    db.from("content_drafts").select("client_id,status", {count:"exact"}).limit(3000),
    db.from("blog_publications").select("id,client_id,status", {count:"exact"}).limit(3000),
    db.from("crm_lite_settings").select("client_id,enabled,sms_alerts_enabled", {count:"exact"}).limit(3000),
    db.from("notification_jobs").select("client_id,status,block_reason", {count:"exact"}).limit(3000),
    db.from("backlink_opportunities").select("client_id,stage", {count:"exact"}).limit(3000),
    db.from("social_accounts").select("client_id,publish_enabled", {count:"exact"}).limit(3000),
    db.from("subscriptions").select("client_id,livemode,status", {count:"exact"}).limit(3000),
    db.from("portal_users").select("client_id,is_active", {count:"exact"}).limit(3000),
    db.from("report_measurements").select("client_id,source,window_end,created_at", {count:"exact"}).eq("status", "measured").limit(3000),
    db.from("client_brand_workspaces").select("id,client_id,name,status,blog_site_id,gsc_property,ga4_property", {count:"exact"}).limit(3000),
    db.from("brand_boards").select("client_id,status", {count:"exact"}).limit(3000),
    db.from("inquiry_sources").select("client_id,enabled", {count:"exact"}).limit(3000),
    db.from("content_drafts").select("id,client_id,status,title,topic,request_task_id,created_at", {count:"exact"}).limit(3000),
    db.from("blog_publications").select("id,client_id,draft_id,draft_version,status,last_error,released_at,scheduled_at", {count:"exact"}).limit(3000),
  ]);
  if (completeRead(clientsQ) === null) {
    return <section className="surface p-5" role="alert">The client roster could not be loaded. No health conclusions were drawn. Please retry.</section>;
  }
  // A full page is an ambiguous truncated result, never a complete count.
  const sourceResults = [
    ["Keywords", keywordsQ], ["Websites", sitesQ], ["Search Console", gscQ],
    ["Analytics", ga4Q], ["Business Profile", gbpQ], ["Drafts", draftsQ],
    ["Blog publishing", publicationsQ], ["CRM Lite", liteQ],
    ["SMS alerts", notificationsQ], ["Backlinks", backlinksQ],
    ["Social accounts", socialQ], ["Subscriptions", subscriptionsQ], ["Client portal", portalQ],
  ] as const;
  const failedSources = sourceResults.filter(([, query]) => completeRead<unknown>(query) === null).map(([name]) => name);
  // null: read failed; []: successful empty read.
  const inputs: HealthInputs = {
    clients: clientsQ.data ?? [],
    keywords: completeRead(keywordsQ),
    sites: completeRead(sitesQ),
    gsc: completeRead(gscQ),
    ga4: completeRead(ga4Q),
    gbp: completeRead(gbpQ),
    drafts: completeRead(draftsQ),
    publications: completeRead(publicationsQ),
    lite: completeRead(liteQ),
    notifications: completeRead(notificationsQ),
    backlinks: completeRead(backlinksQ),
    social: completeRead(socialQ),
    subscriptions: completeRead(subscriptionsQ),
    portal: completeRead(portalQ),
  };
  const summary = buildOperationsHealth(inputs);
  const { counts, coverage } = summary;
  const attention = summary.clients.filter((c) => (c.publicationProblems ?? 0) > 0 || (c.inReview ?? 0) > 0);
  const smsOff = summary.clients.filter((c) => c.crmLite === "sms_off");
  const noLiveBilling = summary.clients.filter((c) => c.liveSubscriptions === 0);
  // A limit reached is not a complete dataset. Fail closed rather than
  // present truncated source totals as if all clients were accounted for.
  const v2SourceErrors = [
    ...failedSources,
    ...(completeRead(measuredQ) === null ? ["Measurement freshness"] : []),
    ...(completeRead(brandsQ) === null ? ["Brand workspaces"] : []),
    ...(completeRead(boardsQ) === null ? ["Brand boards"] : []),
    ...(completeRead(intakeQ) === null ? ["Inquiry intake sources"] : []),
    ...(completeRead(detailedDraftsQ) === null ? ["Draft action queue"] : []),
    ...(completeRead(detailedReleasesQ) === null ? ["Publisher action queue"] : []),
  ];
  const generatedAt = new Date().toISOString();
  const [integrations,operational,reviews,mapGrid] = await Promise.all([
    loadIntegrationHealth(db, summary.clients.map(c=>c.id), generatedAt),
    loadOperationalEvidence(db, summary.clients.map(c=>c.id), generatedAt).catch(()=>null),
    loadRolloutReviews(db,summary.clients.map(c=>c.id)).catch(()=>null),
    loadMapGridWeekly(db, summary.clients.map(c=>c.id), generatedAt).catch(()=>null),
  ]);
  if(!operational)v2SourceErrors.push("Operational evidence");
  if(!mapGrid)v2SourceErrors.push("Map grid weekly scans");
  const v2 = buildOperationsV2({
    integrations,
    operational: operational ?? undefined,
    mapGrid: mapGrid ?? undefined,
    clients: summary.clients,
    measured: completeRead(measuredQ),
    brands: completeRead(brandsQ),
    boards: completeRead(boardsQ),
    intake: completeRead(intakeQ),
    drafts: completeRead(detailedDraftsQ),
    releases: completeRead(detailedReleasesQ),
    sourceErrors: v2SourceErrors,
    now: generatedAt,
  });


  return <div className="space-y-7" data-operations-health>
    {failedSources.length > 0 && <div role="alert" className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" data-source-warning>
      <CircleAlert className="mt-0.5 size-5 shrink-0" />
      <p><strong>Partial visibility:</strong> {failedSources.join(", ")} could not be read. Affected values show Unavailable or Unknown rather than zero.</p>
    </div>}
    <ControlCenterV2 data={v2} reviews={reviews} brands={completeRead(brandsQ)} />
    <details className="rounded-2xl border border-slate-200 bg-slate-50 p-4" data-legacy-health>
      <summary className="cursor-pointer text-sm font-semibold text-navy-900">
        Classic five-layer counts and detailed operations table
      </summary>
      <div className="mt-5 space-y-6">
    <section aria-labelledby="layers-heading" className="space-y-3">
      <div className="flex items-center gap-2">
        <Layers3 className="size-5 text-orange-600" />
        <h2 id="layers-heading" className="text-lg font-semibold text-navy-900">Five-layer operational snapshot</h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <LayerTile number={1} title="Client intelligence" value={display(counts.trackedKeywords)} label="Tracked keywords" href="/clients" />
        <LayerTile number={2} title="Data & intelligence" value={display(coverage.gsc) + " / " + counts.clients} label="Clients with GSC observations" href="/clients" />
        <LayerTile number={3} title="AI content" value={display(counts.inReview)} label="Drafts needing review" href="/production" />
        <LayerTile number={4} title="Work management" value={display(counts.publicationProblems)} label="Publishing exceptions" href="#attention" />
        <LayerTile number={5} title="Execution" value={display(counts.published)} label="Verified published blog releases" href="/production" />
      </div>
    </section>
    <section id="attention" aria-labelledby="attention-heading" className="space-y-3 scroll-mt-28">
      <h2 id="attention-heading" className="flex items-center gap-2 text-lg font-semibold text-navy-900">
        <Workflow className="size-5 text-orange-600" /> Needs attention
      </h2>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {attention.map((c) => <PriorityItem key={c.id} href={"/clients/" + c.id + "/drafts"}
          title={c.name + " · Content workflow"}
          detail={display(c.inReview) + " in review; " + display(c.publicationProblems) + " blocked or uncertain publishing records. Historical blocked attempts may remain visible after successful recovery."} />)}
        {smsOff.length > 0 && <PriorityItem href="/clients" title={smsOff.length + " CRM Lite clients · SMS not activated"}
          detail={display(counts.alertsBlocked) + " blocked alert records. Complete consent, sender approval and delivery tests before enabling any alerts."} tone="blue" />}
        {noLiveBilling.length > 0 && <PriorityItem href="/clients" title="LIVE billing reconciliation"
          detail={noLiveBilling.length + " current clients have no active LIVE subscription recorded in CRM. This does not prove whether they pay outside Compass."} tone="blue" />}
        {!attention.length && !smsOff.length && !noLiveBilling.length && <div className="rounded-xl border border-slate-200 p-4 text-sm text-slate-600">No actionable records in the available sources.</div>}
      </div>
    </section>
    <section aria-labelledby="matrix-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="matrix-heading" className="flex items-center gap-2 text-lg font-semibold text-navy-900">
          <Database className="size-5 text-orange-600" /> Per-client operational health
        </h2>
        <p className="text-xs text-slate-500">Not recorded ≠ disconnected · Zero means confirmed zero rows</p>
      </div>
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm" data-overflow-ok>
        <table className="w-full min-w-[1040px] text-left text-sm">
          <thead><tr className="border-b bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
            <th className="p-3 font-semibold">Client</th>
            <th className="p-3 font-semibold">Tracked keywords</th>
            <th className="p-3 font-semibold">Source observations</th>
            <th className="p-3 font-semibold">Content</th>
            <th className="p-3 font-semibold">CRM Lite</th>
            <th className="p-3 font-semibold">Backlinks</th>
            <th className="p-3 font-semibold">Billing</th>
          </tr></thead>
          <tbody>{summary.clients.map((c) => <ClientRow key={c.id} client={c} />)}</tbody>
        </table>
      </div>
    </section>
      </div>
    </details>
    <footer className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs leading-5 text-slate-600">
      <div className="flex items-start gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-blue-700" />
      <p><strong>Evidence and operating reviews.</strong> Agency rollout stages require human review. Reviews save internal scope, stage and evidence history. Counts come from team-authorized production CRM records.
        A completed scheduled database job is not proof that an external provider delivered a notification.
        An approved draft is not a published article; only published release records count as execution.
        Data observations indicate presence, not automatic freshness. No SMS, billing, approval or publishing actions can be triggered here.</p>
      </div>
      <p className="mt-2 flex items-center gap-2"><ChartNoAxesCombined className="size-4" /> Detailed baseline and growth charts remain in each client Growth page.</p>
    </footer>
  </div>;
}
