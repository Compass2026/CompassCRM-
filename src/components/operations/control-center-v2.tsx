"use client";
import { AgencyRolloutPanel } from "./agency-rollout-panel";
import type { RolloutReview, RolloutBrand } from "@/lib/agency-rollout";
import { FiveLayerOverview } from "./five-layer-overview";
import { buildFiveLayerOverview } from "@/lib/operations-overview";
import { OperationalEvidencePanel } from "./operational-evidence-panel";
import { IntegrationHealthPanel } from "./integration-health-panel";
import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, Circle, Clock3, Filter, Search, ShieldCheck, SlidersHorizontal, WifiOff } from "lucide-react";
import { mapGridHref, type Alert, type ClientReadiness, type Freshness, type MapGridWeekly, type OperationsV2, type ReadinessCheck, type SourceReading } from "@/lib/operations-readiness";

type Tab = "rollout" | "overview" | "attention" | "freshness" | "delivery" | "onboarding";
const tone: Record<Alert["severity"], string> = {
  critical: "border-red-200 bg-red-50 text-red-800",
  attention: "border-amber-200 bg-amber-50 text-amber-800",
  setup: "border-sky-200 bg-sky-50 text-sky-800",
};
const shortDate = (iso: string | null) => iso ? iso.slice(0, 10) : "—";
const sourceTitle: Record<"gsc"|"ga4"|"gbp", string> = {
  gsc: "Search Console", ga4: "Analytics 4", gbp: "Business Profile",
};
const statusText: Record<Freshness, string> = {
  current: "Current window", stale: "Old window", missing: "No measurement", unknown: "Unavailable",
};
const freshnessTone: Record<Freshness, string> = {
  current: "bg-emerald-50 text-emerald-800",
  stale: "bg-amber-50 text-amber-800",
  missing: "bg-slate-100 text-slate-600",
  unknown: "bg-red-50 text-red-800",
};
function FreshnessCell({ record }: { record: SourceReading }) {
  return <div className="space-y-1">
    <span className={"inline-flex rounded-full px-2 py-1 text-[11px] font-semibold " + freshnessTone[record.state]}>{statusText[record.state]}</span>
    {record.windowEnd && <p className="text-xs tabular-nums text-slate-500">Through {shortDate(record.windowEnd)}</p>}
    {record.ageDays !== null && record.state === "stale" && <p className="text-[11px] text-amber-800">{record.ageDays} days since period end</p>}
  </div>;
}
function CheckRow({ check }: { check: ReadinessCheck }) {
  const ok = check.state === "recorded", unknown = check.state === "unknown";
  return <li className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-slate-50">
    {ok ? <CheckCircle2 className="size-4 shrink-0 text-emerald-600"/> :
      unknown ? <AlertTriangle className="size-4 shrink-0 text-red-500"/> :
      <Circle className="size-4 shrink-0 text-amber-500"/>}
    <div className="min-w-0 flex-1"><Link href={check.href} className="font-medium text-slate-700 hover:underline">{check.label}</Link>{check.detail && <p className="mt-1 text-xs leading-5 text-slate-500">{check.detail}</p>}</div>
    <span className={"text-[11px] " + (ok ? "text-emerald-700" : unknown ? "text-red-700" : "text-slate-500")}>
      {ok ? "Recorded" : unknown ? "Unknown" : check.state === "blocked" ? "Blocked" : check.state === "waiting" ? "Waiting" : "Not recorded"}
    </span>
  </li>;
}
function ClientChecklist({ client }: { client: ClientReadiness }) {
  const all = client.readiness.length;
  return <details className="group rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" data-readiness-client={client.id}>
    <summary className="flex cursor-pointer list-none items-center gap-3">
      <div className="flex-1 min-w-0">
        <p className="truncate text-sm font-semibold text-navy-900">{client.name}</p>
        <p className="mt-1 text-xs text-slate-500">{client.recorded} of {all} evidence checks recorded
          {client.unknown ? " · " + client.unknown + " unavailable" : ""}</p>
      </div>
      <div className="w-24 sm:w-36">
        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-orange-500" style={{width:(client.recorded/all*100) + "%"}}/>
        </div>
      </div>
      <span className="text-xs text-slate-500 group-open:rotate-90" aria-hidden="true">▶</span>
    </summary>
    <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100 pt-2">
      {client.readiness.map((r)=><CheckRow check={r} key={r.key}/>)}
    </ul>
    <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
      Evidence readiness only. Services may be out of scope; verify package entitlements and client authorization before marking work required.
      {client.multiBrand && " Multiple brand domains share this parent client; reporting must be checked per brand."}
    </p>
  </details>;
}

const gridTone: Record<MapGridWeekly["status"]["state"], string> = {
  ok: "bg-emerald-50 text-emerald-800", scanning: "bg-blue-50 text-blue-800", due: "bg-slate-100 text-slate-600",
  missed: "bg-red-50 text-red-800", off: "bg-slate-100 text-slate-600",
};
function MapGridWeeklyPanel({ rows }: { rows: MapGridWeekly[] }) {
  if (!rows.length) return null;
  return <section className="space-y-3" aria-label="Map grid weekly scans" data-map-grid-weekly>
    <h3 className="font-semibold text-navy-900">Map grid weekly scans</h3>
    <p className="text-xs leading-5 text-slate-600">Weekly-scheduled Maps grids (Thursdays 14:00 UTC). Before Thursday&apos;s slot the previous ISO week is judged. Missed means no complete scan for that week; partial scans and missing checks are not ranking losses.</p>
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white" data-overflow-ok>
      <table className="w-full min-w-[630px] text-left text-sm">
        <thead><tr className="border-b bg-slate-50 text-xs text-slate-500"><th className="p-3">Client</th><th className="p-3">Grid</th><th className="p-3">Week status</th><th className="p-3">Last complete scan</th></tr></thead>
        <tbody>{rows.map(g => <tr key={g.profileId} className="border-b border-slate-100 align-top last:border-0" data-map-grid-profile={g.profileId}>
          <td className="p-3 font-semibold text-navy-900"><Link href={mapGridHref(g)} className="hover:underline">{g.clientName}</Link></td>
          <td className="p-3 text-xs text-slate-600">{g.label}</td>
          <td className="p-3"><span className={"inline-flex rounded-full px-2 py-1 text-[11px] font-semibold " + gridTone[g.status.state]}>{g.status.title}</span>
            {g.status.state === "missed" && <p className="mt-1 max-w-sm break-words text-xs leading-5 text-slate-600">{g.status.detail}</p>}</td>
          <td className="p-3 text-xs tabular-nums text-slate-600">{shortDate(g.status.lastSuccessAt)}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

export function ControlCenterV2({data,reviews=null,brands=null}:{data:OperationsV2;reviews?:RolloutReview[]|null;brands?:RolloutBrand[]|null}) {
  const [tab,setTab]=useState<Tab>("overview");
  const [term,setTerm]=useState("");
  const [focus,setFocus]=useState<"all"|"critical"|"attention"|"setup">("all");
  const query=term.trim().toLowerCase();
  const clients=useMemo(()=>data.clients.filter(c=>c.name.toLowerCase().includes(query)),[data.clients,query]);
  // Clients outside the full-service roster (map-tracking-only, paused by
  // design) still surface through their Maps grid alerts, filtered by name.
  const names=useMemo(()=>{
    const roster=new Set(data.clients.map(c=>c.id));
    return new Set([...clients.map(c=>c.id),...(data.mapGrid ?? []).filter(g=>!roster.has(g.clientId) && g.clientName.toLowerCase().includes(query)).map(g=>g.clientId)]);
  },[clients,data.clients,data.mapGrid,query]);
  const alerts=useMemo(()=>data.alerts.filter(a=>names.has(a.clientId) && (focus==="all"||a.severity===focus)),
    [data.alerts,names,focus]);
  const scopedAlerts=data.alerts.filter(a=>names.has(a.clientId));
  const urgent=scopedAlerts.filter(a=>a.severity==="critical").length;
  const needsReview=scopedAlerts.filter(a=>a.title==="Article waiting for approval" || a.title==="Social post waiting for approval").length;
  const gaps=data.integrations.length ? data.integrations.filter(e=>names.has(e.clientId) && e.state!=="verified" && e.state!=="running").length : clients.reduce((n,c)=>n+Object.values(c.freshness).filter(r=>r.state!=="current").length,0);
  const overview=useMemo(()=>buildFiveLayerOverview(data,clients.map(c=>c.id)),[data,clients]);
  const tabs:[Tab,string][]=[["overview","Five-layer overview"],["rollout","Agency rollout"],["attention","Action queue"],["freshness","Source freshness"],["delivery","Delivery & work"],["onboarding","Client onboarding"]];
  return <section className="space-y-5" data-control-center-v2>
    <div className="overflow-hidden rounded-3xl bg-gradient-to-br from-slate-900 via-blue-950 to-blue-900 p-6 text-white shadow-lg sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[.2em] text-orange-300">Control Center · Phase 2</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">From visibility to action</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-blue-100/80">Prioritized work, measurement freshness, and client setup evidence across the Five Layers.</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-xs text-blue-100">
          Evidence refreshed {new Date(data.generatedAt).toLocaleString("en-US",{timeZone:"America/Chicago",dateStyle:"medium",timeStyle:"short"})} CT
        </div>
      </div>
      <div className="mt-6 grid grid-cols-2 gap-3 border-t border-white/10 pt-5 sm:grid-cols-4">
        {[
          ["Critical",urgent,"Production exceptions"],
          ["Reviews",needsReview,"Waiting for human approval"],
          ["Reporting gaps",gaps,"Sources needing verification"],
          ["Clients",clients.length,"Selected active or launching"],
        ].map(([title,note,desc])=><div key={title} className="rounded-xl bg-white/5 px-3 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-blue-200">{title}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-white">{note}</p>
          <p className="mt-1 text-[11px] text-blue-200/80">{desc}</p>
        </div>)}
      </div>
    </div>

    <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
          <Search className="size-4 text-slate-400"/>
          <input className="w-full bg-transparent text-sm text-slate-800 outline-none" type="search" placeholder="Filter clients…" aria-label="Filter Control Center clients" value={term} onChange={e=>setTerm(e.target.value)}/>
        </div>
        <span className="flex items-center gap-1 text-xs text-slate-500"><SlidersHorizontal className="size-4"/> {clients.length} clients</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3" role="tablist" aria-label="Control Center views">
        {tabs.map(([key,label])=><button type="button" role="tab" aria-selected={tab===key} key={key} onClick={()=>setTab(key)}
          className={"rounded-lg px-3 py-2 text-xs font-semibold transition " + (tab===key?"bg-navy-900 text-white":"bg-slate-100 text-slate-600 hover:bg-slate-200")}>{label}</button>)}
      </div>
    </div>
    {data.sourceErrors.length>0 && <p role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" data-v2-source-warning>
      <WifiOff className="mr-2 inline size-4"/> Source read failures: {data.sourceErrors.join(", ")}. Unavailable sources never count as healthy or complete.
    </p>}
    {tab==="rollout" && <AgencyRolloutPanel data={{...data,clients}} reviews={reviews} brands={brands}/>}
    {tab==="overview" && <FiveLayerOverview overview={overview}/>}
    {tab==="attention" && <div className="space-y-4" role="tabpanel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-navy-900">Action queue</h3>
          <p className="text-xs text-slate-500">Live exceptions and approvals, grouped by priority. No automatic retries.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Filter className="size-4 text-slate-400"/>
          {(["all","critical","attention","setup"] as const).map(k=><button key={k} type="button" onClick={()=>setFocus(k)}
            aria-pressed={focus===k} className={"rounded-full px-3 py-1.5 font-medium capitalize " +(focus===k?"bg-orange-100 text-orange-900":"bg-slate-100 text-slate-600 hover:bg-slate-200")}>{k}</button>)}
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2" data-action-list>
        {alerts.map(a=><Link key={a.id} href={a.href} className="group rounded-2xl border border-slate-200 bg-white p-4 shadow-sm hover:border-blue-300">
          <div className="flex items-start justify-between gap-3">
            <span className={"rounded-md border px-2 py-1 text-[10px] font-bold uppercase tracking-wide " + tone[a.severity]}>{a.severity}</span>
            <ArrowRight className="size-4 text-slate-400 transition group-hover:translate-x-1"/>
          </div>
          <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{a.clientName}</p>
          <p className="mt-1 text-sm font-semibold text-navy-900">{a.title}</p>
          <p className="mt-1 text-xs leading-5 text-slate-600">{a.detail}</p>
        </Link>)}
        {!alerts.length && <div className="rounded-2xl border border-dashed border-slate-300 p-6 text-sm text-slate-600">
          <ShieldCheck className="mb-2 size-5 text-emerald-600"/> No matching alerts in the sources successfully read. This does not independently verify external providers.
        </div>}
      </div>
    </div>}
    {tab==="freshness" && data.integrations.length > 0 && <IntegrationHealthPanel entries={data.integrations} clients={clients}/>}
    {tab==="freshness" && data.integrations.length === 0 && <section className="space-y-3" role="tabpanel">
      <h3 className="font-semibold text-navy-900">Measurement freshness</h3>
      <p className="text-xs leading-5 text-slate-600">Last recorded measurement-window end. Older than 45 days is flagged. This is <strong>not</strong> an API permission or sync-delivery check. No measurement is never shown as zero.</p>
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white" data-overflow-ok>
        <table className="w-full min-w-[630px] text-left text-sm">
          <thead><tr className="border-b bg-slate-50 text-xs text-slate-500"><th className="p-3">Client</th>
            {(["gsc","ga4","gbp"] as const).map(s=><th key={s} className="p-3">{sourceTitle[s]}</th>)}</tr></thead>
          <tbody>{clients.map(c=><tr key={c.id} className="border-b border-slate-100 last:border-0" data-freshness-client={c.id}>
            <td className="p-3 font-semibold text-navy-900"><Link href={"/clients/"+c.id+"/growth"} className="hover:underline">{c.name}</Link></td>
            {(["gsc","ga4","gbp"] as const).map(s=><td key={s} className="p-3"><FreshnessCell record={c.freshness[s]}/></td>)}
          </tr>)}</tbody>
        </table>
      </div>
    </section>}
    {tab==="freshness" && <MapGridWeeklyPanel rows={(data.mapGrid ?? []).filter(g=>names.has(g.clientId))}/>}
    {tab==="delivery" && !!data.operationalCards?.length && <OperationalEvidencePanel cards={data.operationalCards} clients={clients}/>}
    {tab==="delivery" && !data.operationalCards?.length && <p role="alert" className="rounded-2xl bg-white p-5 text-sm text-slate-600">Operational evidence is unavailable. Reload to retry; no health conclusion was drawn.</p>}
    {tab==="onboarding" && <section className="space-y-3" role="tabpanel">
      <h3 className="font-semibold text-navy-900">Client onboarding evidence</h3>
      <p className="text-xs leading-5 text-slate-600">Expand a client to see its evidence checks. Recorded means verified CRM evidence exists, not that the service is included in the contract. Missing means required evidence is absent; Unknown means it could not be verified. Blocked means stale, partial or failed reporting.</p>
      <div className="grid gap-3 lg:grid-cols-2">{clients.map(c=><ClientChecklist key={c.id} client={c}/>)}</div>
    </section>}
    <footer className="rounded-xl bg-slate-100 px-4 py-3 text-xs leading-5 text-slate-600">
      <Clock3 className="mr-1 inline size-4"/> No outbound alerts, billing changes, SMS sends, or website publishing are triggered by this screen.
      The Control Center links to existing human-governed workflows.
    </footer>
  </section>;
}

