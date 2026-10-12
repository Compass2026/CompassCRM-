"use client";

import { useId, useState } from "react";
import { BarChart3, Eye, MousePointer2, Phone, Navigation, TrendingUp } from "lucide-react";
import { deltaLabel, growthDate, growthSeries, type GrowthMeasurement, type GrowthRange } from "@/lib/client-growth";
import { interactionMix } from "@/lib/growth-visuals";

const number = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const shortDate = (date: string) => new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
const colors = ["#2563eb", "#f97316", "#8b5cf6", "#14b8a6"];
const icons = [Eye, MousePointer2, Phone, Navigation];
type Series = ReturnType<typeof growthSeries>[number];
type Slice = { key: string; label: string; value: number; color: string };

export function GrowthDonut({ items, label, totalLabel, selected, onSelect }: { items: Slice[]; label: string; totalLabel: string; selected?: string | null; onSelect?: (key: string | null) => void }) {
  const [local, setLocal] = useState<string | null>(null);
  const active = selected === undefined ? local : selected;
  const choose = (key: string | null) => onSelect ? onSelect(key) : setLocal(key);
  const total = items.reduce((sum, i) => sum + i.value, 0);
  const current = items.find(i => i.key === active);
  return <div aria-label={label} className="min-w-0">
    <div className="relative mx-auto h-52 w-52">
      <svg viewBox="0 0 200 200" className="h-full w-full -rotate-90" aria-hidden="true">
        <circle cx="100" cy="100" r="78" fill="none" stroke="#f1f5f9" strokeWidth="22" />
        {total > 0 && items.map((item, index) => <circle key={item.key} cx="100" cy="100" r="78" fill="none" stroke={item.color} strokeWidth={active === item.key ? 28 : 22} pathLength="100" strokeDasharray={`${item.value / total * 100} ${100 - item.value / total * 100}`} strokeDashoffset={-items.slice(0, index).reduce((sum, i) => sum + i.value, 0) / total * 100} className="cursor-pointer transition-[opacity,stroke-width] motion-reduce:transition-none" opacity={!active || active === item.key ? 1 : .25} onClick={() => choose(active === item.key ? null : item.key)} />)}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-4xl font-semibold tracking-tight text-navy-900">{number(current?.value ?? total)}</span>
        <span className="mt-1 max-w-28 text-xs text-slate-500">{current?.label ?? totalLabel}</span>
        {current && total > 0 && <span className="mt-1 text-xs font-semibold text-blue-700">{(current.value / total * 100).toFixed(1)}%</span>}
      </div>
    </div>
    <div className="mt-3 space-y-1" aria-label={`${label} segments`}>
      {items.map(item => <button type="button" key={item.key} aria-pressed={active === item.key} onClick={() => choose(active === item.key ? null : item.key)} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${active === item.key ? "bg-blue-50 ring-1 ring-blue-200" : "hover:bg-slate-50"}`}>
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} /><span className="flex-1 text-slate-600">{item.label}</span><strong className="text-navy-900">{number(item.value)}</strong><span className="w-10 text-right text-slate-500">{total ? Math.round(item.value / total * 100) : 0}%</span>
      </button>)}
      {active && <button type="button" onClick={() => choose(null)} className="w-full rounded-lg py-2 text-xs font-semibold text-blue-700 hover:bg-blue-50">Show all segments</button>}
    </div>
  </div>;
}

function PerformancePlot({ series, color, limit, bars }: { series: Series; color: string; limit: number; bars: boolean }) {
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  const [showBaseline, setShowBaseline] = useState(true);
  const points = limit ? series.points.slice(-limit) : series.points;
  const baseline = series.change.delta !== null ? series.baseline?.value : null;
  const measured = points.filter(p => p.status === "measured" && p.value !== null);
  if (!points.length) return <p className="flex h-72 items-center justify-center text-sm text-slate-500">No measurements in this date range.</p>;
  const maximum = Math.max(1, ...measured.map(p => p.value!), showBaseline ? baseline ?? 0 : 0) * 1.15;
  const first = Date.parse(points[0].window_end), last = Date.parse(points.at(-1)!.window_end);
  const x = (date: string) => first === last ? 398 : 56 + (Date.parse(date) - first) / (last - first) * 680;
  const y = (value: number) => 225 - value / maximum * 195;
  const path = points.map((p, i) => p.status !== "measured" || p.value === null ? "" : `${i === 0 || points[i - 1].status !== "measured" || points[i - 1].value === null ? "M" : "L"}${x(p.window_end)},${y(p.value)}`).join(" ");
  // Close each continuous segment separately so unavailable observations leave a gap.
  const area = path.split("M").filter(Boolean).map(segment => {
    const coords = segment.trim().split("L");
    return `M${coords[0].split(",")[0]},225 L${segment.trim()} L${coords.at(-1)!.split(",")[0]},225 Z`;
  }).join(" ");
  const current = points[active ?? points.length - 1] ?? points.at(-1)!;
  return <div>
    <div className="mt-5 flex min-h-12 flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-slate-500" aria-live="polite" data-testid="chart-readout"><span className="font-semibold text-navy-900">{growthDate(current.window_end)}</span><span className="mx-2 text-slate-300">/</span>{current.status === "measured" && current.value !== null ? number(current.value) : "Not measured"} <span className="text-xs">{series.metric.label.toLowerCase()}</span></p>
      {baseline !== null && baseline !== undefined && <button type="button" aria-pressed={showBaseline} onClick={() => setShowBaseline(!showBaseline)} className={`rounded-full border px-3 py-1.5 text-xs ${showBaseline ? "border-orange-200 bg-orange-50 text-orange-700" : "border-slate-200 text-slate-500"}`}><span aria-hidden="true">┄ </span> Starting baseline: {number(baseline)}</button>}
    </div>
    <svg viewBox="0 0 760 270" role="img" aria-label={`${series.metric.label} ${bars ? "bar" : "line"} chart. Use the dated buttons below to inspect values.`} className="mt-2 w-full overflow-visible" data-testid="performance-plot">
      <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity=".22" /><stop offset="100%" stopColor={color} stopOpacity=".015" /></linearGradient></defs>
      {[0, 1, 2, 3, 4].map(i => <g key={i}><line x1="56" x2="736" y1={225 - i * 48.75} y2={225 - i * 48.75} stroke="#e2e8f0" strokeDasharray="3 5" /><text x="43" y={229 - i * 48.75} textAnchor="end" fill="#64748b" fontSize="11">{new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(maximum * i / 4)}</text></g>)}
      {showBaseline && baseline !== null && baseline !== undefined && <line x1="56" x2="736" y1={y(baseline)} y2={y(baseline)} stroke="#f97316" strokeDasharray="6 5" strokeWidth="1.5" />}
      {!bars && <><path d={area} fill={`url(#${id})`} /><path d={path} fill="none" stroke={color} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" /></>}
      {points.map((p, i) => <g key={p.id} onMouseEnter={() => setActive(i)}>
        {p.status === "measured" && p.value !== null && (bars ? <rect x={x(p.window_end) - Math.min(22, 260 / points.length)} y={y(p.value)} width={Math.min(44, 520 / points.length)} height={Math.max(1, 225 - y(p.value))} rx="5" fill={color} opacity={active === i ? 1 : .7} /> : <circle cx={x(p.window_end)} cy={y(p.value)} r={active === i ? 6 : 4} fill="white" stroke={color} strokeWidth="3" />)}
        {points.length <= 7 || i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 6) === 0 ? <text x={x(p.window_end)} y="252" textAnchor="middle" fill="#64748b" fontSize="11">{shortDate(p.window_end)}</text> : null}
        <rect x={x(p.window_end) - Math.min(32, 320 / points.length)} y="20" width={Math.min(64, 640 / points.length)} height="210" fill="transparent" />
      </g>)}
    </svg>
    <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Inspect chart dates">{points.map((p, i) => <button key={p.id} type="button" aria-label={`Inspect ${growthDate(p.window_end)}`} aria-pressed={active === i} onFocus={() => setActive(i)} onClick={() => setActive(i)} className={`rounded-md px-2.5 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-blue-600 ${active === i ? "bg-blue-100 font-semibold text-blue-800" : "text-slate-500 hover:bg-slate-100"}`}>{shortDate(p.window_end)}</button>)}</div>
  </div>;
}

export function GrowthAnalytics({ rows, range, area }: { rows: GrowthMeasurement[]; range: GrowthRange; area?: "traffic" | "backlinks" }) {
  const series = growthSeries(rows, range).filter(s => area === "traffic" ? s.metric.key.startsWith("website_") : area === "backlinks" ? s.metric.area === "backlinks" : !s.metric.key.startsWith("website_") && s.metric.area !== "backlinks");
  const available = series.filter(s => s.current?.status === "measured");
  const priority = ["website_sessions", "website_users", "website_pageviews", "backlinks_total", "referring_domains", "links_new", "links_lost", "gbp_views", "gbp_clicks", "gbp_call_clicks", "gbp_directions", "search_clicks", "search_impressions"];
  const ordered = [...available].sort((a, b) => (priority.includes(a.metric.key) ? priority.indexOf(a.metric.key) : 20) - (priority.includes(b.metric.key) ? priority.indexOf(b.metric.key) : 20));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [limit, setLimit] = useState(0);
  const [bars, setBars] = useState(false);
  const selected = ordered.find(s => s.key === selectedKey) ?? ordered[0];
  const mix = interactionMix(series);
  if (!selected && area) return <p className="rounded-2xl border border-dashed border-blue-200 bg-white p-6 text-sm text-slate-500">{area === "traffic" ? "Traffic will appear after GA4 has reportable data. Imports allow four days for processing; missing data is never shown as zero." : "No profile baseline recorded yet. Add a dated backlink-provider report to establish the starting profile."}</p>;
  if (!selected) return <div className="rounded-2xl border border-dashed border-blue-200 bg-white/70 p-8 text-center"><BarChart3 className="mx-auto size-8 text-blue-400" /><h3 className="mt-3 font-semibold text-navy-900">Your performance story starts here</h3><p className="mt-2 text-sm text-slate-500">Charts appear as verified measurements become available. Explore your tracked keywords below.</p></div>;
  const color = colors[Math.max(0, ordered.indexOf(selected)) % colors.length];
  return <section aria-label={area === "traffic" ? "Website traffic analytics" : area === "backlinks" ? "Backlink profile analytics" : "Interactive performance analytics"} className="space-y-5">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {ordered.map((s, i) => {
        const Icon = icons[i % icons.length], active = selected.key === s.key;
        const good = s.change.delta !== null && s.change.delta !== 0 && (s.change.delta > 0) !== s.lowerIsBetter;
        return <button type="button" key={s.key} onClick={() => setSelectedKey(s.key)} aria-pressed={active} aria-label={`Chart ${s.metric.label}`} className={`relative overflow-hidden rounded-2xl border bg-white p-5 text-left shadow-sm transition-[border-color,box-shadow] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${active ? "border-blue-500 shadow-md ring-1 ring-blue-500" : "border-slate-200 hover:border-blue-300 hover:shadow-md"}`}>
          <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-slate-500">{s.metric.label}</span><span className="rounded-xl p-2" style={{ backgroundColor: `${colors[i % colors.length]}12`, color: colors[i % colors.length] }}><Icon className="size-4" /></span></div>
          <p className="mt-3 text-4xl font-semibold tracking-tight text-navy-900">{number(s.current!.value!)}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2"><span className={`rounded-md px-2 py-1 text-[11px] font-semibold ${s.change.delta === null || s.change.delta === 0 ? "bg-slate-100 text-slate-600" : good ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{s.change.delta === null ? "No comparison" : s.baseline?.value ? `${s.change.delta > 0 ? "+" : ""}${(s.change.delta / s.baseline.value * 100).toFixed(1)}%` : `${s.change.delta > 0 ? "+" : ""}${number(s.change.delta)}`}</span><span className="text-[11px] text-slate-500">{s.change.delta === null ? "See measurement details" : "vs. starting baseline"}</span></div>
          <p className="mt-2 text-[11px] text-slate-500">{s.definition.source}{s.definition.source === "Google Analytics 4" && ` · ${s.definition.scope.split(" | ").at(-1)?.replaceAll("_", " ")}`}</p><p className="mt-3 text-[11px] text-slate-400">Period ending {growthDate(s.current!.window_end)}</p>
          <span className="absolute inset-x-0 bottom-0 h-1" style={{ backgroundColor: active ? colors[i % colors.length] : "transparent" }} />
        </button>;
      })}
    </div>
    <div className={area ? "grid gap-5" : "grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]"}>
      <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-blue-600">Performance over time</p><h3 className="mt-1.5 text-xl font-semibold tracking-tight text-navy-900">{selected.metric.label}</h3></div><div className="flex rounded-lg bg-slate-100 p-1" aria-label="Chart history length">{[{ label: "Last 3", value: 3 }, { label: "Last 6", value: 6 }, { label: "All", value: 0 }].map(item => <button key={item.value} type="button" aria-pressed={limit === item.value} onClick={() => setLimit(item.value)} className={`rounded-md px-3 py-1.5 text-xs font-medium ${limit === item.value ? "bg-white text-navy-900 shadow-sm" : "text-slate-500 hover:text-navy-900"}`}>{item.label}</button>)}</div></div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><label className="min-w-0 text-xs text-slate-500">Explore metric<select aria-label="Chart metric" value={selected.key} onChange={e => setSelectedKey(e.target.value)} className="ml-2 max-w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-navy-900">{ordered.map(s => <option key={s.key} value={s.key}>{s.metric.label}{ordered.filter(o => o.metric.key === s.metric.key).length > 1 ? ` · ${s.definition.scope} · ${s.definition.source}` : ""}</option>)}</select></label><div className="flex gap-1" aria-label="Chart style">{[false, true].map(bar => <button type="button" key={String(bar)} aria-pressed={bars === bar} onClick={() => setBars(bar)} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${bars === bar ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:bg-slate-50"}`}>{bar ? "Bars" : "Line"}</button>)}</div></div>
        <PerformancePlot key={`${selected.key}/${limit}/${range.start}/${range.end}`} series={selected} color={color} limit={limit} bars={bars} />
        <div className="mt-5 flex flex-wrap gap-x-8 gap-y-3 border-t border-slate-100 pt-4"><div><p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Starting baseline</p><p className="mt-1 text-lg font-semibold text-navy-900">{selected.baseline?.value == null ? "Not measured" : number(selected.baseline.value)} <span className="text-xs font-normal text-slate-500">{growthDate(selected.baseline?.window_end)}</span></p></div><div><p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Change from baseline</p><p className="mt-1 text-sm font-semibold text-navy-900">{deltaLabel(selected.change.delta, selected.baseline?.value)}</p></div></div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{selected.change.reason}. {selected.metric.key === "gbp_views" ? "Impressions across Search, Maps, devices and days. Not unique people." : selected.metric.key === "gbp_call_clicks" ? "Call-button clicks do not confirm connected calls." : "Hover over the chart or select a date to inspect results."} Source: {selected.definition.source}. {area === "traffic" && "Visitors are distinct within each period, not additive across months. Sessions and page views are not leads. Partial periods have no growth comparison."} {selected.definition.source === "Google Search Console property totals" && "Complete calendar months of web search, without query or page filters. Search clicks are not sessions or leads."}</p>
      </div>
      {!area && <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><p className="text-[10px] font-bold uppercase tracking-[.18em] text-blue-600">Google Business Profile</p><h3 className="mt-1.5 text-xl font-semibold tracking-tight text-navy-900">How people engage</h3>{mix ? <><p className="mt-2 text-xs text-slate-500">{growthDate(mix.start)} to {growthDate(mix.end)}</p><GrowthDonut key={`${mix.source}/${mix.start}/${mix.end}`} items={mix.items} label="GBP interaction mix" totalLabel="profile actions" /><p className="mt-4 border-t border-slate-100 pt-3 text-[11px] leading-relaxed text-slate-500">Click a segment to explore. Counts are actions, not unique people or confirmed leads. Source: {mix.source}.</p></> : <div className="flex min-h-64 flex-col items-center justify-center text-center"><TrendingUp className="size-8 text-slate-300" /><p className="mt-3 text-sm text-slate-500">The activity breakdown appears when website clicks, call-button clicks and directions share a measured period and source.</p></div>}</div>}
    </div>
  </section>;
}
