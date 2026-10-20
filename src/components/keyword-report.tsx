import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  compareMonths, ga4Months, gbpMonths, gscMonths, inquirySummary, keywordReport, nextWeekly,
  type KeywordRow, type MonthlyPoint, type OrganicState,
} from "@/lib/keyword-report";
import { gridMetrics, withinRadius, type GridConfig } from "@/lib/map-grid";
import { SOURCE_POLICY, type IntegrationEvidence } from "@/lib/integration-health";
import type { loadKeywordReport } from "@/lib/keyword-report-data";

type Data = NonNullable<Awaited<ReturnType<typeof loadKeywordReport>>["data"]>;
const TZ = "America/Chicago";
const day = (s?: string | null) => s ? new Date(s.length === 10 ? `${s}T12:00:00Z` : s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: s.length === 10 ? "UTC" : TZ }) : "None";
const stamp = (s?: string | null) => s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ, timeZoneName: "short" }) : "None";
const month = (p: string) => new Date(`${p}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const n = (v: number | null | undefined) => v == null ? "Unavailable" : v.toLocaleString("en-US", { maximumFractionDigits: 1 });
const signed = (v: number | null) => v == null ? "No comparison" : v === 0 ? "No change" : `${v > 0 ? "+" : "−"}${Math.abs(v).toLocaleString("en-US")}`;
const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
const path = (u: string | null) => { try { return u ? new URL(u).pathname : "—"; } catch { return u ?? "—"; } };
const stateLabel: Record<OrganicState, string> = { ranked: "", not_found: "Not in top 100", third_party: "Third-party page matched" };
const obsText = (o: KeywordRow["latest"]) => !o ? "Not checked" : o.state === "ranked" ? `#${o.position}` : stateLabel[o.state];
const tone = (k: string) => ({ up: "text-emerald-700", entered: "text-emerald-700", down: "text-red-700", dropped: "text-red-700" } as Record<string, string>)[k] ?? "text-slate-600";
const healthTone: Record<string, string> = { verified: "bg-emerald-50 text-emerald-800", current: "bg-emerald-50 text-emerald-800", stale: "bg-amber-50 text-amber-800", failed: "bg-red-50 text-red-800", missing: "bg-red-50 text-red-800", partial: "bg-amber-50 text-amber-800", pending: "bg-blue-50 text-blue-800", running: "bg-blue-50 text-blue-800", waiting: "bg-blue-50 text-blue-800", unknown: "bg-slate-100 text-slate-700", unconfigured: "bg-slate-100 text-slate-700", baseline: "bg-blue-50 text-blue-800" };

function Section({ title, kicker, children, id }: { title: string; kicker: string; children: React.ReactNode; id: string }) {
  return <section aria-labelledby={id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 print:break-inside-avoid">
    <p className="text-[10px] font-bold uppercase tracking-[.18em] text-blue-600">{kicker}</p>
    <h3 id={id} className="mt-1 text-xl font-semibold tracking-tight text-navy-900">{title}</h3>
    <div className="mt-4">{children}</div>
  </section>;
}
function Table({ caption, head, rows }: { caption: string; head: string[]; rows: React.ReactNode[][] }) {
  return <div className="overflow-x-auto"><table className="w-full text-left text-xs"><caption className="sr-only">{caption}</caption>
    <thead><tr>{head.map(h => <th key={h} scope="col" className="whitespace-nowrap border-b p-2 font-semibold text-slate-600">{h}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={i} className="border-b last:border-0 align-top">{r.map((c, j) => j === 0 ? <th key={j} scope="row" className="p-2 font-medium">{c}</th> : <td key={j} className="p-2">{c}</td>)}</tr>)}</tbody></table></div>;
}
function Pill({ state, children }: { state: string; children: React.ReactNode }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${healthTone[state] ?? healthTone.unknown}`}>{children}</span>;
}
function MonthTable({ caption, points, cols, note }: { caption: string; points: MonthlyPoint[]; cols: [string, string][]; note: string }) {
  if (!points.length) return <p className="text-sm text-muted-foreground">No imported periods. This source is unavailable, not zero.</p>;
  return <>
    <Table caption={caption} head={["Period", ...cols.map(c => c[1]), "Coverage", "Imported"]} rows={points.map(p => [
      p.complete ? month(p.period) : `${day(p.period)} – ${day(p.period_end)}`,
      ...cols.map(([k]) => n(p.values[k])),
      p.complete ? "Complete month" : "Partial (month to date)", day(p.created_at)])}/>
    <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{note}</p>
  </>;
}

export function KeywordReport({ data, now, clientId }: { data: Data; now: string; clientId: string }) {
  const report = keywordReport({ keywords: data.keywords, observations: data.observations, runs: data.runs, siteHost: data.siteHost, now });
  const { cohort, perRun } = report;
  const first = perRun[0], last = perRun.at(-1);
  const locationName = (id: string | null) => data.locations.find(l => l.id === id)?.name ?? "Location not recorded";
  const gsc = gscMonths(data.gsc), ga4 = ga4Months(data.ga4), gbp = gbpMonths(data.gbp);
  const clicks = compareMonths(gsc, "search_clicks"), impressions = compareMonths(gsc, "search_impressions");
  const sessions = compareMonths(ga4, "website_sessions");
  const inq = inquirySummary(data.inquiries);
  const health = (s: IntegrationEvidence["source"]) => data.health.find(h => h.source === s);
  const thirdPartyLatest = report.rows.filter(r => r.latest?.state === "third_party");
  const mismatches = report.rows.filter(r => r.pageMismatch);
  const published = data.work;

  // Maps: compare two scans only when their geometry and keywords are identical.
  const grid = data.grids[0];
  const latestScan = grid?.runs[0], priorScan = grid?.runs[1];
  const geom = (c?: GridConfig) => c?.geometry ?? null;
  const center = geom(latestScan?.config)?.center ?? latestScan?.checks[0];
  const comparableScans = !!latestScan && !!priorScan && JSON.stringify(geom(latestScan.config)) === JSON.stringify(geom(priorScan.config)) && JSON.stringify(latestScan.config.keywords) === JSON.stringify(priorScan.config.keywords);
  const radii: (number | null)[] = [1, 2, 5, null];
  const mapRows = latestScan ? latestScan.config.keywords.map(k => {
    const checks = latestScan.checks.filter(c => c.keyword === k.keyword);
    return [k.keyword, ...radii.map(r => { const m = gridMetrics(center ? withinRadius(checks, center, r) : checks); return m.complete ? `${m.top3Percent}% top 3 · avg ${n(m.averageFound)} · ${m.complete}/${m.total} pts` : "No completed points"; })];
  }) : [];
  const packFirst = first ? data.observations.filter(o => o.run_id === first.run.id && o.result_type === "map_pack") : [];
  const packLast = last ? data.observations.filter(o => o.run_id === last.run.id && o.result_type === "map_pack") : [];
  const top3 = (rows: typeof packFirst) => rows.filter(o => o.position !== null && o.position <= 3).length;

  const rankRunning = report.running;
  const sources: React.ReactNode[][] = [
    ["Website organic rank (DataForSEO Google, desktop, top 100)",
      last ? `${day(last.run.started_at)} check` : "None",
      stamp(report.lastSuccess?.completed_at), report.lastFailure ? `${stamp(report.lastFailure.started_at)} · ${report.lastFailure.error}` : "None recorded",
      `Weekly, Mon 06:00 UTC · next ${stamp(nextWeekly(1, 6, now))}`,
      <Pill key="o" state={rankRunning ? "running" : report.statusCounts.stale ? "stale" : last ? "current" : "missing"}>{rankRunning ? "Check running" : report.statusCounts.stale ? `${report.statusCounts.stale} stale` : last ? "Current" : "No data"}</Pill>],
    ["Google Maps grid (DataForSEO Maps)",
      latestScan ? `${day(latestScan.started_at)} scan · ${latestScan.checks.length} checks` : "None",
      stamp(latestScan?.completed_at), grid?.lastAttempt && grid.lastAttempt.status === "failed" ? `${stamp(grid.lastAttempt.started_at)} · ${grid.lastAttempt.error ?? "failed"}` : "None recorded",
      grid?.profile.weekly_enabled ? `Weekly, Thu 14:00 UTC · next ${stamp(nextWeekly(4, 14, now))}` : "Manual scans only (weekly off)",
      <Pill key="m" state={latestScan ? (comparableScans ? "current" : "baseline") : "missing"}>{latestScan ? (comparableScans ? "Current" : "Baseline only") : "No scan"}</Pill>],
    ...(["gsc", "ga4", "gbp"] as const).map(s => { const h = health(s); return [
      SOURCE_POLICY[s].label + (s === "ga4" ? " (all channels)" : s === "gbp" ? " (profile actions)" : " (property totals)"),
      h?.windowEnd ? `Through ${day(h.windowEnd)}` : "None", stamp(h?.lastSuccess), h?.state === "failed" ? `${stamp(h.lastAttempt)} · ${h.attemptResult}` : "None recorded",
      SOURCE_POLICY[s].cadence, <Pill key={s} state={h?.state ?? "unknown"}>{h?.state ?? "unknown"}</Pill>]; }),
    ["Website form inquiries (CRM Lite)", inq.first ? `${day(inq.first)} – ${day(inq.latest)}` : "None", inq.latest ? `Last received ${stamp(inq.latest)}` : "None", "Not tracked", "Real time on form submit",
      <Pill key="i" state={inq.total ? "current" : "missing"}>{inq.total ? "Receiving" : "No inquiries"}</Pill>],
  ];

  const nextActions = [
    thirdPartyLatest.length > 0 && `Correct organic matching so only ${data.siteHost} counts as the website (${thirdPartyLatest.length} of ${report.tracked} latest results matched a third-party page). The rank-sync fix in this pilot PR needs review and deployment; past checks are classified on read and not rewritten.`,
    mismatches.length > 0 && `Review ${mismatches.length} keyword${mismatches.length === 1 ? "" : "s"} where Google ranks a different page on the site than the intended owner page.`,
    !comparableScans && latestScan && `Maps trend starts with the next scan on the same ${geom(latestScan.config)?.version ?? "grid"} geometry (next scheduled ${stamp(nextWeekly(4, 14, now))}). Earlier scans used different geometry and are a separate baseline.`,
    ga4.length > 0 && "Analytics imports all-channel sessions only. Organic sessions need a channel breakdown added to the GA4 import before organic traffic can be reported.",
    data.draftsInReview > 0 && `${data.draftsInReview} content draft${data.draftsInReview === 1 ? " is" : "s are"} waiting for review. Nothing is published until approved.`,
  ].filter(Boolean) as string[];

  return <div className="space-y-6">
    <div className="rounded-3xl bg-navy-900 p-6 text-white sm:p-8">
      <p className="text-[10px] font-bold uppercase tracking-[.22em] text-blue-200">Pilot report · for team review · not sent to the client</p>
      <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white">{data.client.name}: keywords to results</h2>
      <p className="mt-2 max-w-3xl text-sm text-blue-100/80">Built only from stored provider records. Opening this page calls no provider and starts no scan. Website rank, Google Maps rank and Search Console average position are separate measurements and are never mixed.</p>
      <div className="mt-5 flex flex-wrap gap-2 text-xs"><span className="rounded-full bg-white/10 px-3 py-1">Website {data.siteHost ?? "not set"}</span><span className="rounded-full bg-white/10 px-3 py-1">Read {stamp(now)}</span><Link href={`/clients/${clientId}/maps`} className="inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1">Maps dashboard <ArrowUpRight className="size-3"/></Link><Link href={`/clients/${clientId}/growth`} className="inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1">Growth dashboard <ArrowUpRight className="size-3"/></Link></div>
    </div>

    <Section id="plain" kicker="In plain language" title="Where things stand">
      <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-slate-700">
        {first && last && first !== last && <li>Of the {plural(cohort.size, "tracked keyword")} measured the same way at the first check ({day(first.run.started_at)}) and the latest ({day(last.run.started_at)}), the website was in Google&apos;s top 10 for <strong>{cohort.top10Before}</strong> then and <strong>{cohort.top10After}</strong> now (top 3: {cohort.top3Before} → {cohort.top3After}). {cohort.improved} moved up, {cohort.declined} moved down, {cohort.unchanged} held, {cohort.entered} entered the top 100 and {cohort.dropped} dropped out.{cohort.excludedThirdParty > 0 && ` ${plural(cohort.excludedThirdParty, "keyword is", "keywords are")} left out because a directory or social page was matched instead of the website.`}</li>}
        {clicks.latest && <li>Search Console, {month(clicks.latest.period)}: <strong>{n(clicks.latest.values.search_clicks)}</strong> clicks and {n(impressions.latest?.values.search_impressions)} impressions ({signed(clicks.vsPrevious)} clicks vs {clicks.previous ? month(clicks.previous.period) : "no prior month"}). First imported month {clicks.first ? month(clicks.first.period) : "none"}: {n(clicks.first?.values.search_clicks)} clicks.</li>}
        {latestScan && <li>Google Maps scan {day(latestScan.started_at)}: {plural(latestScan.config.keywords.length, "keyword")} at {plural(latestScan.config.points.length, "point")}. {comparableScans ? ` Compared with the ${day(priorScan!.started_at)} scan on the same grid.` : " This is the first scan on this grid, so it is a starting point, not a trend."}</li>}
        <li>Website form inquiries: <strong>{inq.total}</strong>{inq.first ? ` since ${day(inq.first)}, when the form was connected` : ""}. How each visitor found the site is not recorded.</li>
        <li>Work published: {published.length ? [...published.reduce((m, w) => m.set(w.kind, (m.get(w.kind) ?? 0) + 1), new Map<string, number>())].map(([k, c]) => `${c} ${k === "gbp" ? "Business Profile" : k === "social" ? "social" : "blog"} post${c === 1 ? "" : "s"}`).join(", ") : "none recorded"}. Work completed is shown next to results, but it does not prove it caused them.</li>
      </ul>
      {nextActions.length > 0 && <><h4 className="mt-5 text-sm font-semibold text-navy-900">Next actions</h4><ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-slate-700">{nextActions.map(a => <li key={a}>{a}</li>)}</ol></>}
    </Section>

    <Section id="health" kicker="Source health" title="What each number is based on">
      <Table caption="Source health" head={["Source", "Observation window", "Last successful refresh", "Last failed attempt", "Expected cadence", "Status"]} rows={sources}/>
      <p className="mt-2 text-[11px] text-slate-500">Freshness rules are the existing ones: ranks go stale after 14 days; Search Console and Business Profile 45-day windows; Analytics a 7-day window with a 4-day provider delay. A missing source is unavailable, not zero. BrightLocal history (to Sep 27) is a different provider and is not mixed into these comparisons.</p>
    </Section>

    <Section id="organic" kicker="Website organic rank" title="Tracked keywords, check by check">
      <Table caption="Organic results per check" head={["Check", "Keywords checked", "Website found", "Top 3", "Top 10", "Top 20", "Not in top 100", "Third-party match (excluded)"]}
        rows={perRun.map(p => [day(p.run.started_at), p.keywords, p.verified - p.notFound, p.top3, p.top10, p.top20, p.notFound, p.thirdParty])}/>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{plural(report.tracked, "keyword is", "keywords are")} selected for tracking. They are not every query Google shows the site for. Counts are keywords, one observation each per check. Top 10 includes top 3. A third-party match means a directory, social or review page with the business name ranked before the website; the website&apos;s own position for that check is unknown, so it is never counted.{report.duplicates > 0 && ` ${report.duplicates} duplicate observations were ignored.`} Missed checks: {report.lastFailure ? `latest failure ${day(report.lastFailure.started_at)} (${report.lastFailure.error})` : "none"}.</p>
      <div className="mt-4 rounded-xl bg-slate-50 p-4 text-xs leading-relaxed text-slate-700"><strong>Stable comparison group:</strong> {plural(cohort.size, "keyword")} measured the same way at the first and the latest complete check. {cohort.excludedThirdParty} excluded for a third-party match, {cohort.excludedMissing} excluded as missing from one of the two checks. Up {cohort.improved} · down {cohort.declined} · held {cohort.unchanged} · entered top 100 {cohort.entered} · dropped out {cohort.dropped} · not in top 100 either time {cohort.absentBoth}.</div>
    </Section>

    <Section id="keywords" kicker="Keyword table" title="Each tracked keyword">
      <Table caption="Tracked keyword ranking detail" head={["Keyword", "Service · intent", "Intended page", "Ranking page (latest)", "First check", "Latest check", "Movement", "Status"]}
        rows={report.rows.map(r => [
          <span key="k">{r.keyword}{r.is_money && <span className="ml-1 rounded bg-orange-50 px-1 text-[10px] text-orange-700">money</span>}<span className="mt-0.5 block font-normal text-slate-500">{locationName(r.location_id)} · Google desktop · top 100</span></span>,
          <span key="s">{r.service ?? "No service linked"}<span className="block text-slate-500">{r.intent ?? "intent not set"}</span></span>,
          path(r.target_url),
          r.latest?.state === "ranked" ? <span key="u" className={r.pageMismatch ? "font-semibold text-amber-700" : ""}>{path(r.latest.url_ranked)}{r.pageMismatch && <span className="block font-normal">Differs from intended page, review</span>}</span>
            : r.latest?.state === "third_party" ? <span key="u" className="text-amber-700">{r.latest.url_ranked ? new URL(r.latest.url_ranked).hostname : "—"}<span className="block">Not the website</span></span> : "—",
          <span key="b">{obsText(r.baseline)}<span className="block text-slate-500">{r.baseline ? day(r.baseline.recorded_at) : ""}</span></span>,
          <span key="l">{obsText(r.latest)}<span className="block text-slate-500">{r.latest ? day(r.latest.recorded_at) : ""}</span></span>,
          <span key="m" className={tone(r.movement.kind)}>{r.movement.label}</span>,
          <Pill key="st" state={r.status === "current" ? "current" : r.status}>{r.status === "not_checked" ? "Not checked" : r.status[0].toUpperCase() + r.status.slice(1)}</Pill>,
        ])}/>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">First check is the first observation from the same location (the first observed baseline, not a pre-engagement baseline; no earlier comparable record exists). Lower is better. Ranking pages are reported as observed and are never remapped.</p>
    </Section>

    <Section id="maps" kicker="Google Maps" title="Map rankings (separate from the website)">
      {latestScan ? <>
        <Table caption="Latest map scan by radius" head={["Keyword", "Within 1 mi", "Within 2 mi", "Within 5 mi", "Full scan"]} rows={mapRows}/>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">Scan {stamp(latestScan.started_at)} · geometry {geom(latestScan.config)?.version ?? "legacy grid"} · {latestScan.config.points.length} points · search mode {latestScan.config.search_this_area ? "search this area" : "standard"}. Radius is distance from the business. Percent in top 3 uses completed points only; average excludes points where the business was not found. {priorScan ? (comparableScans ? `Compared with ${day(priorScan.started_at)}.` : `The earlier scan (${day(priorScan.started_at)}, ${priorScan.config.points.length} points) used a different grid, so it is not compared.`) : ""} No points are interpolated.</p>
      </> : <p className="text-sm text-muted-foreground">No completed map scan.</p>}
      {first && last && <p className="mt-3 text-xs text-slate-700">Local pack in normal Google results, checked from the home location: in the top 3 for {top3(packFirst)} of {packFirst.length} keywords on {day(first.run.started_at)} and {top3(packLast)} of {packLast.length} on {day(last.run.started_at)}.</p>}
      <Link href={`/clients/${clientId}/maps`} className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-blue-700">Open the Maps dashboard (radius controls, history) <ArrowUpRight className="size-3"/></Link>
    </Section>

    <Section id="traffic" kicker="Traffic" title="Search Console, Analytics and Business Profile">
      <h4 className="mb-2 text-sm font-semibold">Search Console: property totals ({data.gsc[0]?.property ?? "no property"})</h4>
      <MonthTable caption="Search Console monthly totals" points={gsc} cols={[["search_clicks", "Clicks"], ["search_impressions", "Impressions"]]} note="Complete calendar months only, imported daily. Property totals, not only tracked keywords. Search Console average position is a different measure from the rank checks above and is not shown as a rank."/>
      <h4 className="mb-2 mt-5 text-sm font-semibold">Analytics 4: website sessions, all channels</h4>
      <MonthTable caption="Analytics monthly sessions" points={ga4} cols={[["website_sessions", "Sessions"], ["website_users", "Users"]]} note={`Filtered to ${data.siteHost}. These are all-channel sessions; organic sessions are not imported yet. Month to date runs about 4 days behind. Latest complete month: ${sessions.latest ? `${month(sessions.latest.period)} ${n(sessions.latest.values.website_sessions)} sessions (${signed(sessions.vsPrevious)} vs prior month)` : "none"}.`}/>
      <h4 className="mb-2 mt-5 text-sm font-semibold">Business Profile actions</h4>
      <MonthTable caption="Business Profile monthly actions" points={gbp} cols={[["calls", "Call clicks"], ["website", "Website clicks"], ["directions", "Direction requests"], ["views", "Profile views"]]} note="Interactions recorded by Google, not unique leads or customers. One person can produce several actions."/>
    </Section>

    <Section id="inquiries" kicker="Inquiries" title="Captured website inquiries">
      {inq.total ? <div className="grid gap-5 md:grid-cols-3">
        <Table caption="Inquiries by month" head={["Month (Central)", "Inquiries"]} rows={inq.byMonth}/>
        <Table caption="Inquiries by page" head={["Page submitted from", "Inquiries"]} rows={inq.byPage}/>
        <Table caption="Inquiries by form" head={["Form", "Inquiries"]} rows={inq.byForm}/>
      </div> : <p className="text-sm text-muted-foreground">No inquiries captured.</p>}
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">Counts every submission received, including any internal tests (not marked in the data). The form records the page, not the traffic source, so no inquiry is attributed to a keyword, to organic search or to revenue. Roofing and holiday lighting forms are kept separate.</p>
    </Section>

    <Section id="work" kicker="Work performed" title="Published work">
      {published.length ? <Table caption="Published work" head={["Published", "Type", "Link"]} rows={published.map(w => [day(w.published_on), w.title, w.url ? <a key="u" href={w.url} target="_blank" rel="noreferrer" className="text-blue-700 underline">View</a> : "No link"])}/> : <p className="text-sm text-muted-foreground">No published work recorded.</p>}
      <p className="mt-2 text-[11px] text-slate-500">Published items only, dated by their verified publish time. {data.draftsInReview} draft{data.draftsInReview === 1 ? "" : "s"} in review {data.draftsInReview === 1 ? "is" : "are"} not counted. This is agency activity, shown separately from results.</p>
    </Section>
  </div>;
}
