"use client";
import { useState } from "react";
import { ArrowUpRight, CheckCircle2 } from "lucide-react";
import { growthDate, type GrowthRange, type GrowthWork } from "@/lib/client-growth";
import { httpUrl } from "@/lib/backlinks";
const kinds = [{key:"blog",label:"Blog posts"},{key:"social",label:"Social posts"},{key:"gbp",label:"GBP posts"}] as const;
function publicLink(url:string|null) { try{return httpUrl(url??"");}catch{return null;} }
export function GrowthWorkSummary({work,range,error}:{work:GrowthWork[];range:GrowthRange;error?:string|null}) {
  const [kind,setKind]=useState("all");
  const [month,setMonth]=useState("");
  const [expanded,setExpanded]=useState(false);
  const dated=work.filter(w=>w.published_on>=range.start&&w.published_on<=range.end);
  const selected=dated.filter(w=>kind==="all"||w.kind===kind);
  const months=new Map<string,number>();
  for(const w of selected) months.set(w.published_on.slice(0,7),(months.get(w.published_on.slice(0,7))??0)+1);
  const entries=[...months].sort(([a],[b])=>a.localeCompare(b)).slice(-12);
  const activeMonth=entries.some(([m])=>m===month)?month:"";
  const shown=selected.filter(w=>!activeMonth||w.published_on.startsWith(activeMonth));
  const maximum=Math.max(1,...entries.map(([,count])=>count));
  return <section aria-label="Published work" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-emerald-700">Work behind the results</p><h3 className="mt-1.5 text-xl font-semibold text-navy-900">Published work</h3><p className="mt-2 text-xs text-slate-500">Recorded Compass publications within your reporting dates. Drafts and approvals are excluded.</p></div><CheckCircle2 className="size-7 text-emerald-500"/></div>
    {error?<p role="alert" className="mt-5 text-sm text-amber-800">{error}</p>:<>
      <div className="mt-5 grid grid-cols-3 gap-3">{kinds.map(item=><button key={item.key} type="button" aria-pressed={kind===item.key} onClick={()=>{setKind(kind===item.key?"all":item.key);setMonth("");setExpanded(false);}} className={`rounded-xl border p-3 text-left transition-colors sm:p-4 ${kind===item.key?"border-emerald-400 bg-emerald-50":"border-slate-100 bg-slate-50 hover:border-emerald-200"}`}><span className="text-xs text-slate-500">{item.label}</span><span className="mt-2 block text-3xl font-semibold text-navy-900">{dated.filter(w=>w.kind===item.key).length}</span></button>)}</div>
      {!!entries.length&&<div className="mt-6"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold text-slate-600">Publication history · months with recorded work</p><button type="button" onClick={()=>{setKind("all");setMonth("");setExpanded(false);}} className="text-xs font-semibold text-emerald-700">Show all published work</button></div><div className="mt-3 flex items-end gap-2 overflow-x-auto pb-2" aria-label="Publication months">{entries.map(([m,count])=><button type="button" key={m} aria-label={`${m}: ${count} publications`} aria-pressed={activeMonth===m} onClick={()=>{setMonth(activeMonth===m?"":m);setExpanded(false);}} className="min-w-14 flex-1 rounded-lg px-2 pt-2 text-center text-xs text-slate-600 hover:bg-emerald-50"><span className="block font-semibold">{count}</span><span className={`mx-auto mt-1 block max-w-12 rounded-t-md ${activeMonth===m?"bg-emerald-600":"bg-emerald-300"}`} style={{height:16+count/maximum*65}}/><span className="mt-2 block">{new Date(`${m}-01T12:00:00Z`).toLocaleDateString("en-US",{month:"short",year:"2-digit",timeZone:"UTC"})}</span></button>)}</div></div>}
      <div aria-live="polite" className="mt-5"><p className="text-xs text-slate-500">{shown.length} recorded publications{activeMonth?` in ${activeMonth}`:""}{kind!=="all"?` · ${kinds.find(k=>k.key===kind)?.label}`:""}</p><ul className="mt-2 divide-y divide-slate-100">{shown.slice(0,expanded?shown.length:5).map(w=>{const url=publicLink(w.url);return <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"><div className="min-w-0"><p className="break-words font-medium text-navy-900">{w.title}</p><p className="mt-1 text-xs text-slate-500">{growthDate(w.published_on)} · {kinds.find(k=>k.key===w.kind)?.label}</p></div>{url&&<a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700">View publication<ArrowUpRight className="size-3.5"/><span className="sr-only">: {w.title}</span></a>}</li>;})}</ul>{shown.length>5&&<button type="button" onClick={()=>setExpanded(!expanded)} className="mt-3 text-xs font-semibold text-blue-700">{expanded?"Show fewer publications":`Show all ${shown.length} publications`}</button>}</div>
      {!dated.length&&<p className="mt-3 text-sm text-slate-500">No published work is recorded for these dates. Work completed outside the connected publishing records may not appear here.</p>}
    </>}
    <p className="mt-5 border-t border-slate-100 pt-4 text-[11px] text-slate-500">Website page releases will appear once deployment evidence is connected. Publication counts describe completed work, not traffic or leads.</p>
  </section>;
}
