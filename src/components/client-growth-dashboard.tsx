import { GrowthRankingSummary } from "./growth-ranking-summary";
import type { GrowthRanking } from "@/lib/growth-rankings";
import Link from "next/link";
import { ArrowUpRight, BarChart3, CalendarDays, Flag, Layers3 } from "lucide-react";
import { REPORT_AREAS, STATUS_LABELS, agencyToday } from "@/lib/reporting";
import { deltaLabel, growthDate, growthSeries, type GrowthMeasurement, type GrowthRange, type SearchHistory } from "@/lib/client-growth";

const number=(value:number|null|undefined)=>value==null?"Not measured":value.toLocaleString("en-US",{maximumFractionDigits:2});
const value=(r?:GrowthMeasurement)=>r?.status==="measured"?number(r.value):r?STATUS_LABELS[r.status]:"Not measured";
function Trend({points,label}:{points:{date:string;value:number|null}[];label:string}) {
  const measured=points.filter(p=>p.value!==null);
  if(measured.length<2) return <p className="flex h-24 items-center text-xs text-muted-foreground">A trend appears after two dated measurements.</p>;
  const values=measured.map(p=>p.value!);
  const min=Math.min(0,...values),max=Math.max(1,...values),span=max-min||1;
  const first=Date.parse(points[0].date),last=Date.parse(points.at(-1)!.date);
  const x=(d:string)=>12+(Date.parse(d)-first)/(last-first||1)*276;
  const y=(v:number)=>80-(v-min)/span*64;
  // Missing observations break the line. They never become zero.
  const path=points.map((p,i)=>p.value===null?"":`${i===0||points[i-1].value===null?"M":"L"}${x(p.date)},${y(p.value)}`).join(" ");
  return <figure className="mt-4">
    <svg viewBox="0 0 300 100" className="h-24 w-full text-blue-600" role="img" aria-label={`${label}: ${measured.map(p=>`${growthDate(p.date)} ${number(p.value)}`).join(", ")}`}>
      <path d="M12 80H288 M12 48H288 M12 16H288" fill="none" stroke="currentColor" strokeOpacity=".1" />
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
      {measured.map((p,i)=><circle key={i} cx={x(p.date)} cy={y(p.value!)} r="3.5" fill="currentColor" />)}
    </svg>
    <figcaption className="flex justify-between text-[11px] text-muted-foreground"><span>{growthDate(points[0].date)}</span><span>{growthDate(points.at(-1)!.date)}</span></figcaption>
  </figure>;
}

export function ClientGrowthDashboard({rows,search,range,action,teamClientId,error,searchError,rankings,rankingsError}:{rankings:GrowthRanking[];rankingsError?:string|null;rows:GrowthMeasurement[];search:SearchHistory[];range:GrowthRange;action:string;teamClientId?:string;error?:string|null;searchError?:string|null}) {
  const series=growthSeries(rows,range);
  const measured=series.filter(s=>s.current?.status==="measured");
  const starting=series.map(s=>s.baseline?.window_end).filter((d):d is string=>!!d).sort()[0];
  const latest=measured.map(s=>s.current!.window_end).sort().at(-1);
  const visibleSearch=search.filter(s=>s.period_start>=range.start&&s.period_end<=range.end);
  return <section aria-label="Client growth dashboard" className="space-y-6">
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy-900 to-blue-900 p-6 text-white sm:p-8">
      <p className="text-xs font-semibold uppercase tracking-[.18em] text-blue-200">Your marketing progress</p>
      <h2 className="mt-2 text-2xl font-semibold text-white sm:text-3xl">Where we started. How you&apos;re growing.</h2>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-blue-100">Your starting point, latest measured results, and the work moving your business forward.</p>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {[{icon:Flag,label:"Earliest recorded baseline",text:growthDate(starting)},{icon:CalendarDays,label:"Latest measurement in view",text:growthDate(latest)},{icon:Layers3,label:"Measured series in view",text:error?"Unavailable":String(measured.length)}].map(({icon:Icon,label,text})=><div key={label} className="rounded-xl border border-white/15 bg-white/10 p-4"><Icon className="mb-2 size-4 text-orange-300"/><p className="text-xs text-blue-100">{label}</p><p className="mt-1 text-lg font-semibold">{text}</p></div>)}
      </div>
      <p className="mt-4 text-xs text-blue-100">Each metric keeps its own original baseline. Measurements recorded after work began are labeled as the first available measurement.</p>
    </div>
    <GrowthRankingSummary rows={rankings} error={rankingsError} teamClientId={teamClientId}/>
    <form action={action} className="surface flex flex-wrap items-end gap-3 p-4" aria-label="Progress dates">
      <label className="text-sm">Show<select name="range" defaultValue={range.mode} className="field-sm mt-1 block"><option value="all">Since starting with Compass</option><option value="month">Monthly view</option><option value="custom">Custom dates</option></select></label>
      <label className="text-sm">Month<input name="month" type="month" className="field-sm mt-1 block" defaultValue={range.end.slice(0,7)} max={agencyToday().slice(0,7)}/></label>
      <label className="text-sm">From<input name="start" type="date" className="field-sm mt-1 block" defaultValue={range.mode==="custom"?range.start:""} max={agencyToday()}/></label>
      <label className="text-sm">Through<input name="end" type="date" className="field-sm mt-1 block" defaultValue={range.end} max={agencyToday()}/></label>
      <button className="rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white">Update view</button>
      <p className="w-full text-xs text-muted-foreground">Date filters include complete measurement windows only. Original baselines stay fixed. Monthly and custom views never prorate totals.</p>
    </form>
    {range.error&&<p role="alert" className="callout">{range.error} Showing all history.</p>}
    {error?<p role="alert" className="callout">{error}</p>:<>
      {!rows.length&&<p className="callout">Your starting scorecard is being prepared. Available search history appears below; missing measurements are not shown as zero.</p>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {REPORT_AREAS.map(area=>{
          const items=series.filter(s=>s.metric.area===area.key);
          return <article key={area.key} className="surface min-w-0 border-t-4 border-t-blue-500 p-5">
            <h3 className="flex items-center gap-2 font-semibold text-navy-900"><BarChart3 className="size-4 text-blue-600"/>{area.label}</h3>
            {!items.length?<div className="mt-4"><p className="text-sm text-muted-foreground">Baseline not yet recorded</p><p className="mt-2 text-xs text-muted-foreground">{area.next}</p></div>:items.map(s=><div key={s.key} className="mt-5 border-t pt-4 first:border-0">
              <p className="font-medium text-sm">{s.metric.label}</p>
              {s.definition.source==="Google Business Profile via Zernio"&&<p className="mt-1 text-xs text-muted-foreground">Automatically imported complete months. {s.metric.key==="gbp_views"?"Search and Maps impressions across devices and days, not unique people.":s.metric.key==="gbp_call_clicks"?"Call-button clicks do not confirm connected calls.":"Google may revise recent reporting."}</p>}
              <p className="mt-1 break-words text-xs text-muted-foreground">{s.definition.scope}{s.definition.platform!=="none"?` · ${s.definition.platform} / ${s.definition.channel}`:""}</p>
              <div className="mt-3 grid grid-cols-2 gap-3"><div><p className="text-[11px] uppercase tracking-wider text-muted-foreground">Starting baseline</p><p className="mt-1 text-lg font-semibold">{value(s.baseline)}</p><p className="text-xs text-muted-foreground">{growthDate(s.baseline?.window_end)}</p></div><div><p className="text-[11px] uppercase tracking-wider text-muted-foreground">{range.mode==="all"?"Latest result":"Result in selected dates"}</p><p className="mt-1 text-lg font-semibold text-navy-900">{value(s.current)}</p><p className="text-xs text-muted-foreground">{growthDate(s.current?.window_end)}</p></div></div>
              <p className={`mt-3 text-xs font-semibold ${s.change.delta===null||s.change.delta===0?"text-muted-foreground":(s.change.delta>0)!==s.lowerIsBetter?"text-emerald-700":"text-amber-700"}`}>{deltaLabel(s.change.delta,s.baseline?.value)}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">{s.change.reason}</p>
              {s.stale&&<p className="mt-2 text-xs font-medium text-amber-700">Update due: measurement is over 45 days old at the end of this view.</p>}
              <Trend label={s.metric.label} points={s.points.map(p=>({date:p.window_end,value:p.status==="measured"?p.value:null}))}/>
              <p className="mt-3 text-[11px] text-muted-foreground">Source: {s.definition.source} · {s.baseline?.context==="before_work"?"Verified before work began":"First available measurement"}</p>
              {s.current&&s.current.window_start!==s.current.window_end&&<p className="text-[11px] text-muted-foreground">Result window: {growthDate(s.current.window_start)} to {growthDate(s.current.window_end)}</p>}
              <details className="mt-3 text-xs"><summary className="cursor-pointer text-blue-700">Measurement history</summary><ul className="mt-2 space-y-1">{s.points.map(p=><li key={p.id}>{growthDate(p.window_start)} to {growthDate(p.window_end)}: {value(p)}</li>)}</ul></details>
            </div>)}
          </article>;
        })}
      </div>
    </>}
    <div className="surface p-5 sm:p-6"><h3 className="font-semibold text-navy-900">Search Console history</h3><p className="mt-2 text-sm text-muted-foreground">Available imported query and page rows. These are not property-wide totals; coverage can vary between imports. The earliest import may be after your work with Compass started.</p>
      {searchError?<p role="alert" className="mt-3 text-sm">{searchError}</p>:visibleSearch.length?<><div className="mt-4 grid gap-6 sm:grid-cols-2">{(["clicks","impressions"] as const).map(metric=><div key={metric}><p className="text-sm font-medium">Imported {metric}</p><Trend label={`Imported search ${metric}`} points={visibleSearch.map(s=>({date:s.period_end,value:s[metric]}))}/></div>)}</div><details className="mt-4"><summary className="cursor-pointer text-sm text-blue-700">View source periods</summary><div className="overflow-x-auto"><table className="mt-3 w-full text-left text-xs"><thead><tr><th className="p-2">Period</th><th>Clicks</th><th>Impressions</th><th>Imported rows</th></tr></thead><tbody>{visibleSearch.map(s=><tr key={`${s.period_start}/${s.period_end}`} className="border-t"><td className="p-2 whitespace-nowrap">{growthDate(s.period_start)} to {growthDate(s.period_end)}</td><td>{number(s.clicks)}</td><td>{number(s.impressions)}</td><td>{number(s.imported_rows)}</td></tr>)}</tbody></table></div></details></>:<p className="mt-4 text-sm text-muted-foreground">No imported search periods within these dates.</p>}
    </div>
    <div className="flex flex-wrap gap-3 text-sm"><Link className="inline-flex items-center gap-1 rounded-lg bg-blue-50 px-4 py-3 font-semibold text-blue-800" href={teamClientId?`/clients/${teamClientId}/backlinks`:"/portal/backlinks"}>Backlink growth <ArrowUpRight className="size-4"/></Link><Link className="rounded-lg bg-orange-50 px-4 py-3 font-semibold text-orange-800" href={teamClientId?`/clients/${teamClientId}/reports`:"/portal/work-log"}>{teamClientId?"Record measurements & review reports":"See the work completed"}</Link></div>
  </section>;
}
