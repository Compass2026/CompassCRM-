import Link from "next/link";
import { ArrowRight, Layers3 } from "lucide-react";
import type { buildFiveLayerOverview, LayerOverview } from "@/lib/operations-overview";

type Overview = ReturnType<typeof buildFiveLayerOverview>;
const segments = [
  ["recorded", "Recorded", "bg-blue-600"],
  ["missing", "Missing", "bg-orange-400"],
  ["waiting", "Waiting", "bg-amber-300"],
  ["blocked", "Blocked", "bg-red-500"],
  ["unknown", "Unknown", "bg-slate-400"],
] as const;

function EvidenceBar({ layer }: { layer: LayerOverview }) {
  return <div className="mt-4">
    <p className="text-xs text-slate-600">{layer.checks.recorded} of {layer.total} evidence checks recorded</p>
    {layer.total > 0 && <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
      {segments.map(([key,,color]) => layer.checks[key] > 0 && <span key={key} className={color} style={{width: (layer.checks[key] / layer.total * 100) + "%"}}/>)}
    </div>}
    <dl className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-600">
      {segments.map(([key,label]) => <div key={key} className="flex gap-1"><dt>{label}</dt><dd className="font-semibold tabular-nums">{layer.checks[key]}</dd></div>)}
    </dl>
  </div>;
}
function NextAction({ layer }: { layer: LayerOverview }) {
  return layer.next ? <Link href={layer.next.href} className="mt-4 block rounded-xl border border-blue-100 bg-blue-50/70 p-3 hover:border-blue-300" data-layer-next={layer.id}>
    <span className="flex items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-wide text-blue-700">Next action <ArrowRight className="size-3 shrink-0"/></span>
    <p className="mt-2 text-xs font-semibold text-navy-900">{layer.next.clientName}</p>
    <p className="mt-1 text-sm font-medium text-navy-900">{layer.next.title}</p>
    <p className="mt-1 text-xs leading-5 text-slate-600">{layer.next.detail}</p>
  </Link> : <p className="mt-4 rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-600">
    No next action established from the available evidence. Check the detailed workflows before authorizing work.
  </p>;
}
export function FiveLayerOverview({ overview }: { overview: Overview }) {
  return <section className="space-y-4" role="tabpanel" aria-label="Five-layer overview" data-five-layer-overview>
    <div>
      <h3 className="flex items-center gap-2 text-lg font-semibold text-navy-900"><Layers3 className="size-5 text-orange-600"/> Your five-layer operating system</h3>
      <p className="mt-1 text-xs leading-5 text-slate-600">{overview.clients} selected clients. Evidence and open actions are shown separately. Recorded setup is not proof of delivery, growth, or permission to publish.</p>
      {overview.partial && <p className="mt-2 text-xs font-semibold text-amber-800" data-overview-partial>Partial visibility. Source failures keep this overview incomplete.</p>}
    </div>
    <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
      {overview.layers.map(layer => <article key={layer.id} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" data-overview-layer={layer.id}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[.15em] text-orange-700">Layer {layer.id}</span>
          <span className={"rounded-full px-2 py-1 text-[10px] font-semibold " + (layer.critical ? "bg-red-50 text-red-800" : layer.alerts ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-600")}>{layer.alerts} observed alerts</span>
        </div>
        <h4 className="mt-2 text-sm font-semibold text-navy-900">{layer.title}</h4>
        <p className="mt-1 text-xs leading-5 text-slate-600">{layer.purpose}</p>
        {layer.id === 4 && layer.total === 0 ? <p className="mt-4 text-xs leading-5 text-slate-600">Review and follow-up queue evidence. No completion percentage inferred.</p> : <EvidenceBar layer={layer}/>}
        <NextAction layer={layer}/>
      </article>)}
      <aside className="min-w-0 rounded-2xl border border-blue-100 bg-slate-50 p-4" data-overview-support>
        <p className="text-[10px] font-bold uppercase tracking-[.15em] text-blue-700">Supports all five layers</p>
        <h4 className="mt-2 text-sm font-semibold text-navy-900">{overview.support.title}</h4>
        <p className="mt-1 text-xs leading-5 text-slate-600">{overview.support.purpose}</p>
        <p className="mt-3 text-xs font-semibold text-slate-700">{overview.support.alerts} observed alerts</p>
        <EvidenceBar layer={overview.support}/>
        <NextAction layer={overview.support}/>
      </aside>
    </div>
    {(overview.other.total > 0 || overview.other.alerts > 0) && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
      {overview.other.total} evidence checks and {overview.other.alerts} alerts await layer assignment. They remain visible in the detailed views.
      <NextAction layer={overview.other}/>
    </div>}
    <p className="text-[11px] leading-5 text-slate-500">Bars show the composition of readiness evidence, not a system health score. Brand-specific requirements remain separate under their parent client.</p>
  </section>;
}
