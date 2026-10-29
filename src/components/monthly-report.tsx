import type { Comparison, AnchorSummary, Editorial, MonthlyReportSnapshot } from "@/lib/monthly-report";

// One frozen version of a monthly report. Renders only what the snapshot
// holds; it never reads live data, so a version looks the same every time.
// `audience` = "client" hides internal notes (the audit is never passed in).
type Report = Omit<MonthlyReportSnapshot, "audit">;
const TZ = "America/Chicago";
const day = (s?: string | null) => s ? new Date(s.length === 10 ? `${s}T12:00:00Z` : s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: s.length === 10 ? "UTC" : TZ }) : "None";
const stamp = (s?: string | null) => s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ, timeZoneName: "short" }) : "None";
const n = (v: number | null | undefined) => v == null ? "Not available" : v.toLocaleString("en-US", { maximumFractionDigits: 1 });
const deliverableLabel: Record<string, string> = { blog_posts: "Blog posts", facebook_posts: "Facebook posts", gbp_posts: "Business Profile posts", page_refreshes: "Page refreshes" };

function Section({ title, kicker, children, id }: { title: string; kicker: string; children: React.ReactNode; id: string }) {
  return <section aria-labelledby={id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 print:break-inside-avoid print:rounded-none print:border-0 print:border-t print:p-0 print:pt-4 print:shadow-none">
    <p className="text-[10px] font-bold uppercase tracking-[.18em] text-[var(--report-accent)]">{kicker}</p>
    <h3 id={id} className="mt-1 text-xl font-semibold tracking-tight text-slate-900">{title}</h3>
    <div className="mt-4 space-y-4">{children}</div>
  </section>;
}
function Table({ caption, head, rows }: { caption: string; head: string[]; rows: React.ReactNode[][] }) {
  return <div className="overflow-x-auto"><table className="w-full text-left text-xs"><caption className="sr-only">{caption}</caption>
    <thead><tr>{head.map(h => <th key={h} scope="col" className="whitespace-nowrap border-b p-2 font-semibold text-slate-600">{h}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={i} className="border-b align-top last:border-0">{r.map((c, j) => j === 0 ? <th key={j} scope="row" className="p-2 font-medium">{c}</th> : <td key={j} className="p-2 tabular-nums">{c}</td>)}</tr>)}</tbody></table></div>;
}
const Note = ({ children }: { children: React.ReactNode }) => <p className="text-[11px] leading-relaxed text-slate-500">{children}</p>;
const Unavailable = ({ children }: { children: React.ReactNode }) => <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700"><strong>Not available.</strong> {children}</p>;

function Anchors({ caption, anchors, mapPack }: { caption: string; anchors: AnchorSummary[]; mapPack?: boolean }) {
  return <Table caption={caption} head={["Date", "Checked on", mapPack ? "In map pack" : "Website ranks", "Top 3", ...(mapPack ? [] : ["Top 10", "Top 20", "Third-party (excluded)"]), "Not checked"]}
    rows={anchors.map(a => [a.label, a.checkedOn.length ? a.checkedOn.map(day).join(", ") : "No check in range", `${a.ranked} of ${a.eligible}`, a.top3,
      ...(mapPack ? [] : [a.top10, a.top20, a.thirdParty]), a.missing])}/>;
}
function Compare({ c }: { c: Comparison }) {
  if ("unavailable" in c) return <Unavailable>{c.from} → {c.to}: {c.unavailable}</Unavailable>;
  return <div className="space-y-2">
    <p className="text-sm"><strong>{c.from} → {c.to}:</strong> {c.comparable} comparable keywords. {c.improved} moved up, {c.declined} moved down, {c.unchanged} unchanged, {c.entered} entered the top 100, {c.dropped} dropped out, {c.absentBoth} not in the top 100 at either date. Top 10: {c.top10[0]} → {c.top10[1]}. Top 3: {c.top3[0]} → {c.top3[1]}.</p>
    <Note>Not comparable and left out: {c.excludedThirdParty} matched a third-party page at one date, {c.excludedMissing} had no check at one date, {c.excludedLocation} were checked from a different location.</Note>
    {(c.gains.length > 0 || c.losses.length > 0) && <div className="grid gap-3 sm:grid-cols-2">
      {c.gains.length > 0 && <Table caption="Largest gains" head={["Largest gains", "From", "To"]} rows={c.gains.map(g => [g.keyword, g.from, g.to])}/>}
      {c.losses.length > 0 && <Table caption="Largest losses" head={["Largest losses", "From", "To"]} rows={c.losses.map(g => [g.keyword, g.from, g.to])}/>}
    </div>}
  </div>;
}

export function MonthlyReportView({ report, editorial, version, status, contentHash }: { report: Report; editorial: Editorial; version: number; status: string; contentHash: string }) {
  const r = report.report;
  const accent = r.brand.primary && /^#[0-9a-f]{6}$/i.test(r.brand.primary) ? r.brand.primary : "#1d4ed8";
  const rk = r.rankings;
  const t = r.traffic;
  const final = status === "approved" || status === "superseded";
  return <article className="space-y-5 print:space-y-6" style={{ ["--report-accent" as string]: accent }}>
    <header className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm print:rounded-none print:border-0 print:shadow-none">
      <div className="h-2" style={{ background: accent }}/>
      <div className="p-5 sm:p-6">
        <p className="text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Monthly report</p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{r.client.name} · {r.period_label}</h2>
        {r.brand.tagline && <p className="mt-1 text-sm text-slate-600">{r.brand.tagline}</p>}
        <p className="mt-3 text-sm text-slate-700">{report.partial ? `Data as of ${stamp(report.cutoff)}` : `Covers ${r.period_label}, America/Chicago calendar month`} · version {version}{final ? "" : ` · ${status.replace("_", " ")}`}</p>
        {report.partial && <p role="note" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900">Partial month: figures run from {day(report.period_start)} to {stamp(report.cutoff)}. This is a preview, not the month&apos;s report.</p>}
        {!report.partial && report.completeness === "incomplete" && <p role="note" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900">Incomplete: {report.exceptions.map(e => e.source).join(", ")} — see Source health. Nothing has been estimated in their place.</p>}
      </div>
    </header>

    <Section id="mr-summary" kicker="Summary" title="What the month shows">
      <ul className="space-y-3">{r.observations.map((o, i) => <li key={i}><p className="text-sm text-slate-900">{o.text}</p><Note>{o.evidence}</Note></li>)}</ul>
      <div>
        <h4 className="text-sm font-semibold">Possible causes</h4>
        {editorial.causes?.length ? <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{editorial.causes.map((c, i) => <li key={i}>{c}</li>)}</ul>
          : <p className="mt-1 text-sm text-slate-600">None recorded. The figures above are observations; no cause is claimed.</p>}
      </div>
      <div>
        <h4 className="text-sm font-semibold">Next actions</h4>
        {editorial.actions?.length ? <Table caption="Next actions" head={["Action", "Why", "Owner"]} rows={editorial.actions.map(a => [a.action, a.reason, a.owner])}/> : <p className="mt-1 text-sm text-slate-600">None recorded.</p>}
      </div>
      {editorial.note && <p className="text-sm text-slate-700">{editorial.note}</p>}
    </Section>

    <Section id="mr-organic" kicker="Organic search" title="Rankings on the website's own pages">
      <p className="text-sm">{rk.tracked} tracked keywords on {rk.siteHost ?? "an unresolved website"}. A directory, social or review page that mentions the business is never counted as the website.</p>
      <Anchors caption="Organic rankings by date" anchors={rk.organic.anchors}/>
      <Compare c={rk.organic.vsPrevious}/>
      <Compare c={rk.organic.vsBaseline}/>
      <Note>Each date uses the keyword&apos;s last check before it, if no older than 14 days. Checks this month: {rk.runsInMonth.complete} complete, {rk.runsInMonth.failed} failed.</Note>
    </Section>

    <Section id="mr-maps" kicker="Google Maps" title="Map pack and local grid">
      <h4 className="text-sm font-semibold">Map pack (from the same keyword checks)</h4>
      <Anchors caption="Map pack by date" anchors={rk.mapPack.anchors} mapPack/>
      <h4 className="text-sm font-semibold">Local grid scans</h4>
      {r.maps.length === 0 ? <Unavailable>No grid scan is set up.</Unavailable> : r.maps.map(g => <div key={g.profile} className="space-y-2">
        {g.current ? <>
          <p className="text-sm"><strong>{g.profile}:</strong> scanned {stamp(g.current.startedAt)} at {n(g.current.points)} points, {g.current.radiusMiles ? `${g.current.radiusMiles}-mile radius` : "radius not recorded"}, centred on {g.current.center}, zoom {n(g.current.zoom)}, {n(g.current.keywords)} keywords. Top 3 in {n(g.current.metrics.top3Percent)}% of {g.current.metrics.complete} checks; average position where found {n(g.current.metrics.averageFound)}.</p>
          {g.comparable && g.previous ? <p className="text-sm">Previous identical scan {stamp(g.previous.startedAt)}: top 3 in {n(g.previous.metrics.top3Percent)}% of {g.previous.metrics.complete} checks.</p>
            : <Note>No comparison: {g.notComparable.join("; ")}. Unlike scans are never combined.</Note>}
        </> : <Unavailable>{g.profile}: {g.notComparable.join("; ")}</Unavailable>}
      </div>)}
    </Section>

    <Section id="mr-traffic" kicker="Traffic" title="Search Console, Analytics and Business Profile">
      <h4 className="text-sm font-semibold">Google Search Console (property totals)</h4>
      {t.gsc.problem ? <Unavailable>{t.gsc.problem}</Unavailable> : <Table caption="Search Console" head={["Month", "Clicks", "Impressions", "Window"]} rows={[
        [r.period_label, n(t.gsc.current.search_clicks?.value), n(t.gsc.current.search_impressions?.value), t.gsc.current.search_clicks ? `${day(t.gsc.current.search_clicks.window_start)} – ${day(t.gsc.current.search_clicks.window_end)}` : report.partial ? "Imported after the month ends" : "No import"],
        ["Previous month", n(t.gsc.previous.search_clicks?.value), n(t.gsc.previous.search_impressions?.value), t.gsc.previous.search_clicks ? `${day(t.gsc.previous.search_clicks.window_start)} – ${day(t.gsc.previous.search_clicks.window_end)}` : "No import"],
      ]}/>}
      {t.querySample.rows > 0 && <>
        <Table caption="Search Console query sample" head={[`Top queries, ${day(t.querySample.start)} – ${day(t.querySample.end)}`, "Clicks", "Impressions"]} rows={t.querySample.top.map(q => [q.query, n(q.clicks), n(q.impressions)])}/>
        <Note>Query sample: a rolling window, not the calendar month, and only the top queries. It does not add up to the property totals.</Note>
      </>}
      <h4 className="text-sm font-semibold">Google Analytics (all channels)</h4>
      {t.ga4.problem ? <Unavailable>{t.ga4.problem}</Unavailable> : <Table caption="Analytics" head={["Period", "Sessions", "Users", "Page views", "Coverage"]} rows={[t.ga4.current, t.ga4.previous].map((p, i) => [
        i === 0 ? r.period_label : "Previous month", n(p.values.website_sessions?.value), n(p.values.website_users?.value), n(p.values.website_pageviews?.value),
        p.coverage === "complete_month" ? "Complete month" : p.coverage === "month_to_date" ? `Month to date, through ${day(p.values.website_sessions?.window_end)}` : "No import"])}/>}
      <Note>Analytics counts visits from every channel. An organic-only figure is not available.</Note>
      <h4 className="text-sm font-semibold">Google Business Profile</h4>
      {t.gbp.problem ? <Unavailable>{t.gbp.problem}</Unavailable> : <Table caption="Business Profile" head={["Month", "Views", "Calls", "Website clicks", "Directions"]} rows={[t.gbp.current, t.gbp.previous].map((p, i) => [
        i === 0 ? r.period_label : "Previous month", n(p.gbp_views?.value), n(p.gbp_call_clicks?.value), n(p.gbp_clicks?.value), n(p.gbp_directions?.value)])}/>}
    </Section>

    <Section id="mr-inquiries" kicker="Inquiries" title="Website inquiries">
      <p className="text-sm"><strong>{r.inquiries.total}</strong> {report.partial ? "so far this month" : `in ${r.period_label}`}; {r.inquiries.previousMonth} the month before.</p>
      {r.inquiries.total > 0 && <div className="grid gap-3 sm:grid-cols-3">
        <Table caption="By source" head={["Source", "Count"]} rows={r.inquiries.bySource.map(([k, v]) => [k, v])}/>
        <Table caption="By form" head={["Form", "Count"]} rows={r.inquiries.byForm.map(([k, v]) => [k, v])}/>
        <Table caption="By page" head={["Page", "Count"]} rows={r.inquiries.byPage.map(([k, v]) => [k, v])}/>
      </div>}
      <Note>Counted without contact details. No test or spam classification is stored, so every submission is counted. Inquiries are not attributed to keywords or revenue.</Note>
    </Section>

    <Section id="mr-work" kicker="Work completed" title="Published this month">
      <Table caption="Work against targets" head={["Deliverable", "Published", "Target", "Remaining", "By service line"]} rows={r.work.rows.map(w => [
        deliverableLabel[w.deliverable], w.completed, w.target, w.remaining, w.bySegment.length ? w.bySegment.map(([k, v]) => `${k} ${v}`).join(" · ") : "—"])}/>
      <Note>{r.work.standard.recorded ? `Targets: the client's recorded delivery standard (v${r.work.standard.version}).` : `Targets: Compass's standard (v${r.work.standard.version}); it is not yet recorded for this client.`} Not counted: {r.work.notCounted.blogDraftsInReview} blog drafts in review, {r.work.notCounted.facebookInReview} Facebook and {r.work.notCounted.gbpInReview} Business Profile posts in review, {r.work.notCounted.approvedNotPublished} approved but not published, {r.work.notCounted.failedPublishes} failed, {r.work.notCounted.refreshesWithoutReceipt} page changes without a live receipt.</Note>
      {r.work.rows.filter(w => w.items.length).map(w => <div key={w.deliverable}>
        <h4 className="text-sm font-semibold">{deliverableLabel[w.deliverable]}</h4>
        <ul className="mt-1 space-y-1 text-sm">{w.items.map((it, i) => <li key={i}>{day(it.date)} · {it.url ? <a className="underline" href={it.url} target="_blank" rel="noreferrer">{it.title}</a> : it.title}{it.segment ? ` · ${it.segment}` : ""}</li>)}</ul>
      </div>)}
    </Section>

    <Section id="mr-health" kicker="Appendix" title="Source health">
      <Table caption="Source health" head={["Source", "Identity", "Latest data", "State", "Note"]} rows={r.health.map(h => [h.source, h.identity, stamp(h.latest), h.state, h.note || "—"])}/>
      {report.exceptions.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm">{report.exceptions.map((e, i) => <li key={i}><strong>{e.source}:</strong> {e.problem}</li>)}</ul>}
      <h4 className="text-sm font-semibold">Definitions</h4>
      <ul className="list-disc space-y-1 pl-5 text-xs text-slate-600">{r.definitions.map((d, i) => <li key={i}>{d}</li>)}</ul>
      <Note>Version {version} · {report.calculation_version} · content {contentHash.slice(0, 19)}…</Note>
    </Section>
  </article>;
}
