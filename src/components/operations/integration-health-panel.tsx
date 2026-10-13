import Link from "next/link";
import { ArrowRight, Database, ShieldCheck } from "lucide-react";
import { SOURCE_POLICY, type IntegrationEvidence, type IntegrationState } from "@/lib/integration-health";
const labels: Record<IntegrationState,string>={verified:"Verified retrieval",failed:"Failed / interrupted",partial:"Partial results",missing:"Missing data",stale:"Stale evidence",unknown:"Unverified",running:"Sync in progress",unconfigured:"Setup needed"};
const tones: Record<IntegrationState,string>={verified:"bg-emerald-50 text-emerald-800",failed:"bg-red-50 text-red-800",partial:"bg-amber-50 text-amber-900",missing:"bg-amber-50 text-amber-900",stale:"bg-amber-50 text-amber-900",unknown:"bg-slate-100 text-slate-700",running:"bg-blue-50 text-blue-800",unconfigured:"bg-blue-50 text-blue-800"};
const date=(value:string|null)=>value ? new Date(value).toLocaleString("en-US",{timeZone:"America/Chicago",dateStyle:"medium",timeStyle:"short"})+" CT" : "Not recorded";
export function IntegrationHealthPanel({entries,clients}:{entries:IntegrationEvidence[];clients:{id:string;name:string}[]}) {
  const ids=new Set(clients.map(c=>c.id));
  const filtered=entries.filter(e=>ids.has(e.clientId));
  const groups=[{label:"Verified",states:["verified"],color:"bg-emerald-500"},{label:"Needs attention",states:["failed","partial","missing","stale"],color:"bg-orange-500"},{label:"Setup / unverified",states:["unconfigured","unknown","running"],color:"bg-slate-400"}];
  return <section className="space-y-4" aria-label="Integration health and data freshness">
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <h3 className="flex items-center gap-2 font-semibold text-navy-900"><Database className="size-5 text-blue-700"/>Integration health & data freshness</h3>
      <p className="mt-2 text-xs leading-5 text-slate-600">GA4, Search Console and GBP reporting. Verified means a recorded provider result matches validated imported data. Configuration alone does not verify access. Shared GBP figures belong to the parent client.</p>
      <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={groups.map(g=>`${g.label}: ${filtered.filter(e=>g.states.includes(e.state)).length}`).join(", ")}>
        {groups.map(g=><div key={g.label} className={g.color} style={{width:`${filtered.length ? 100*filtered.filter(e=>g.states.includes(e.state)).length/filtered.length : 0}%`}}/>)}
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-600">{groups.map(g=><span key={g.label} className="flex items-center gap-2"><span className={`size-2 rounded-full ${g.color}`}/>{g.label} <strong>{filtered.filter(e=>g.states.includes(e.state)).length}</strong></span>)}</div>
    </div>
    {clients.map(client=><section key={client.id} data-integration-client={client.id} className="space-y-3">
      <h4 className="text-sm font-semibold text-navy-900">{client.name}</h4>
      <div className="grid gap-3 xl:grid-cols-3">{filtered.filter(e=>e.clientId===client.id).map(e=><article key={e.source} data-integration-source={e.source} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="text-sm font-semibold text-navy-900">{SOURCE_POLICY[e.source].label}</h5><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${tones[e.state]}`}>{labels[e.state]}</span></div>
        <p className="mt-2 text-xs text-slate-500">{e.configured === null ? "Configuration unavailable" : e.configured ? "Configuration recorded" : "Configuration missing"}</p>
        <dl className="mt-3 space-y-2 text-xs">
          {[["Last attempt",date(e.lastAttempt)],["Result",e.attemptResult],["Last confirmed retrieval",date(e.lastSuccess)],["Latest receipt saved",date(e.lastImported)]].map(([label,value])=><div key={label}><dt className="text-slate-500">{label}</dt><dd className="mt-0.5 break-words font-medium text-slate-800">{value}</dd></div>)}
        </dl>
        <ul className="mt-3 space-y-2 border-t border-slate-100 pt-3">{e.scopes.map((s,i)=><li key={`${s.property}:${i}`} className="rounded-lg bg-slate-50 p-2 text-xs">
          <p className="font-medium text-slate-800">{s.label}</p><p className="mt-1 break-all text-slate-500">{s.property || "No property recorded"}</p>
          <p className="mt-1 text-slate-700">{s.windowEnd ? `Data through ${s.windowEnd}` : "No validated data window"} · {s.state}</p>
        </li>)}</ul>
        <p className="mt-3 text-xs leading-5 text-slate-600">{e.evidence}</p>
        <Link href={e.state === "unconfigured" ? `/clients/${e.clientId}${e.source === "gbp" ? "/social" : ""}` : e.href} className="mt-3 flex items-start gap-2 rounded-lg bg-blue-50 p-3 text-xs font-medium leading-5 text-blue-900"><ArrowRight className="mt-0.5 size-4 shrink-0"/>{e.nextAction}</Link>
        <p className="mt-3 text-[10px] leading-4 text-slate-500">{SOURCE_POLICY[e.source].cadence}. Retrieval becomes stale after 48 hours.</p>
      </article>)}</div>
    </section>)}
    {!clients.length && <p className="rounded-xl bg-white p-5 text-sm text-slate-600">No clients match this filter.</p>}
    <p className="flex items-start gap-2 rounded-xl bg-slate-100 p-3 text-xs leading-5 text-slate-600"><ShieldCheck className="mt-0.5 size-4 shrink-0"/>Failures before an importer starts may have no run record. Missing credentials and live provider permissions are not inferred. This screen does not run syncs or change account access.</p>
  </section>;
}
