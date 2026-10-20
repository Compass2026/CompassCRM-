import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  RANK_STALE_DAYS, compareMonths, ga4Months, gbpMonths, gscMonths, inquirySummary, keywordReport, nextWeekly, scanComparability, trackerHealth,
  type Attempt, type KeywordRow, type MonthlyPoint, type OrganicState, type TrackerState,
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
const hostOf = (u: string | null) => { try { return u ? new URL(u).hostname : "—"; } catch { return "—"; } };
const stateLabel: Record<OrganicState, string> = { ranked: "", not_found: "Not in top 100", third_party: "Third-party page matched" };
const obsText = (o: KeywordRow["latest"]) => !o ? "Not checked" : o.state === "ranked" ? `#${o.position}` : stateLabel[o.state];
const tone = (k: string) => ({ up: "text-emerald-700", entered: "text-emerald-700", down: "text-red-700", dropped: "text-red-700" } as Record<string, string>)[k] ?? "text-slate-600";
const pillTone: Record<string, string> = { verified: "bg-emerald-50 text-emerald-800", current: "bg-emerald-50 text-emerald-800", stale: "bg-amber-50 text-amber-800", partial: "bg-amber-50 text-amber-800", failed: "bg-red-50 text-red-800", missing: "bg-red-50 text-red-800", running: "bg-blue-50 text-blue-800", pending: "bg-blue-50 text-blue-800", waiting: "bg-blue-50 text-blue-800", unknown: "bg-slate-100 text-slate-700", unconfigured: "bg-slate-100 text-slate-700", unavailable: "bg-slate-100 text-slate-700" };
const stateText: Record<TrackerState, string> = { current: "Current", stale: "Stale", failed: "Latest attempt failed", partial: "Latest attempt partial", running: "Check running", missing: "No successful data", unconfigured: "Not set up" };

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
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${pillTone[state] ?? pillTone.unknown}`}>{children}</span>;
}
function Unavailable({ reason }: { reason: string }) {
  return <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700"><strong>Unavailable.</strong> {reason} Nothing is shown rather than data from an unconfirmed source.</p>;
}
function MonthTable({ caption, points, cols, note }: { caption: string; points: MonthlyPoint[]; cols: [string, string][]; note: string }) {
  if (!points.length) return <p className="text-sm text-muted-foreground">No imported periods for this source. It is unavailable, not zero.</p>;
  return <>
    <Table caption={caption} head={["Period", ...cols.map(c => c[1]), "Coverage", "Imported"]} rows={points.map(p => [
      p.complete ? month(p.period) : `${day(p.period)} – ${day(p.period_end)}`,
      ...cols.map(([k]) => n(p.values[k])),
      p.complete ? "Complete month" : "Partial (month to date)", day(p.created_at)])}/>
    <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{note}</p>
  </>;
}
const problemText = (a: Attempt | null) => a ? `${stamp(a.at)} · ${a.outcome}${a.detail ? ` · ${a.detail}` : ""}` : "None recorded";

export function KeywordReport({ data, now, clientId }: { data: Data; now: string; clientId: string }) {
  const { scope } = data;
  const siteHost = scope.siteHost;
  const report = keywordReport({ keywords: data.keywords, observations: data.observations, runs: data.runs, siteHost, now });
  const { cohort, perRun } = report;
  const base = perRun.find(p => p.run.id === cohort.baselineRun?.id), last = perRun.at(-1);
  const earlyRuns = perRun.filter(p => p.beforeBaseline);
  const locationName = (id: string | null) => data.locations.find(l => l.id === id)?.name ?? "Location not recorded";
  const gsc = gscMonths(data.gsc, scope.gscProperty), ga4 = ga4Months(data.ga4, scope.ga4Property, siteHost), gbp = gbpMonths(data.gbp, scope.gbp);
  const clicks = compareMonths(gsc, "search_clicks"), impressions = compareMonths(gsc, "search_impressions");
  const sessions = compareMonths(ga4, "website_sessions");
  const inq = inquirySummary(data.inquiries);
  const health = (s: IntegrationEvidence["source"]) => data.health.find(h => h.source === s);
  const thirdPartyLatest = report.rows.filter(r => r.latest?.state === "third_party");
  const mismatches = report.rows.filter(r => r.pageMismatch);
  const published = data.work;
  const organicHealth = trackerHealth({ attempts: report.attempts, configured: report.tracked > 0, staleDays: RANK_STALE_DAYS, now });

  // Maps: compare only scans whose every frozen input is known and identical.
  const grid = data.grids.length === 1 ? data.grids[0] : null;
  const latestScan = grid?.runs[0], priorScan = grid?.runs[1];
  const comparison = latestScan && priorScan ? scanComparability(priorScan, latestScan) : null;
  const geom = (c?: GridConfig) => c?.geometry ?? null;
  const center = geom(latestScan?.config)?.center ?? null;
  const radii: (number | null)[] = [1, 2, 5, null];
  const metrics = (scan: NonNullable<typeof latestScan>, keyword: string, r: number | null) => {
    const checks = scan.checks.filter(c => c.keyword === keyword);
    const c = geom(scan.config)?.center;
    // Without a recorded center a radius cannot be applied; only the full scan is shown.
    return r !== null && !c ? null : gridMetrics(c ? withinRadius(checks, c, r) : checks);
  };
  const mapRows = latestScan ? latestScan.config.keywords.map(k => [k.keyword, ...radii.map(r => {
    const m = metrics(latestScan, k.keyword, r);
    if (!m) return "No recorded center";
    if (!m.complete) return "No completed points";
    const p = comparison?.comparable ? metrics(priorScan!, k.keyword, r) : null;
    return <span key={String(r)}>{m.top3Percent}% top 3 · avg {n(m.averageFound)} · {m.complete}/{m.total} pts{p?.complete ? <span className="block text-slate-500">prior {p.top3Percent}% ({signed(m.top3Percent! - p.top3Percent!)} pts), avg {n(p.averageFound)}</span> : null}</span>;
  })]) : [];
  const mapAttempts: Attempt[] = (grid?.attempts ?? []).map(r => ({ at: r.started_at, finishedAt: r.completed_at, outcome: r.status === "complete" ? "complete" : ["running", "planned", "posting"].includes(r.status) ? "running" : "failed", detail: r.error }));
  const mapHealth = trackerHealth({ attempts: mapAttempts, configured: !!grid?.profile.enabled, staleDays: RANK_STALE_DAYS, now });
  const mapSchedule = !grid ? (data.grids.length > 1 ? `${data.grids.length} map profiles; the pilot reports one` : "No map profile")
    : !grid.profile.enabled ? "Profile disabled: no scans run"
    : !grid.profile.weekly_enabled ? "Manual scans only (weekly off)"
    : `Configured weekly, Thu 14:00 UTC. Next configured slot ${stamp(nextWeekly(4, 14, now))}; not a confirmed run`;

  const scoped = (s: "gsc" | "ga4" | "gbp", problem: string | null, label: string): React.ReactNode[] => {
    const h = health(s);
    if (problem) return [label, "—", "—", "—", SOURCE_POLICY[s].cadence, <Pill key={s} state="unavailable">Unavailable</Pill>];
    return [label, h?.windowEnd ? `Through ${day(h.windowEnd)}` : "None", stamp(h?.lastSuccess),
      h?.state === "failed" || h?.state === "partial" ? `${stamp(h.lastAttempt)} · ${h.attemptResult}` : "None recorded",
      SOURCE_POLICY[s].cadence, <Pill key={s} state={h?.state ?? "unknown"}>{h?.state ?? "unknown"}</Pill>];
  };
  const sources: React.ReactNode[][] = [
    ["Website organic rank (DataForSEO Google, desktop, top 100)",
      organicHealth.lastSuccess ? `${day(organicHealth.lastSuccess.at)} check` : "None",
      stamp(organicHealth.lastSuccess?.finishedAt), problemText(organicHealth.lastProblem),
      `Configured weekly, Mon 06:00 UTC. Next configured slot ${stamp(nextWeekly(1, 6, now))}; not a confirmed run`,
      <Pill key="o" state={organicHealth.state}>{stateText[organicHealth.state]}</Pill>],
    ["Google Maps grid (DataForSEO Maps)",
      mapHealth.lastSuccess && latestScan ? `${day(mapHealth.lastSuccess.at)} scan · ${latestScan.checks.length} checks` : "None",
      stamp(mapHealth.lastSuccess?.finishedAt), problemText(mapHealth.lastProblem), mapSchedule,
      <Pill key="m" state={grid ? mapHealth.state : "unavailable"}>{grid ? stateText[mapHealth.state] : "Unavailable"}</Pill>],
    scoped("gsc", scope.problems.gsc, `Search Console property totals${scope.gscProperty ? ` (${scope.gscProperty})` : ""}`),
    scoped("ga4", scope.problems.ga4, `Analytics 4, all channels${scope.ga4Property ? ` (${scope.ga4Property}, ${siteHost})` : ""}`),
    scoped("gbp", scope.problems.gbp, `Business Profile actions${scope.gbp ? ` (${scope.gbp.locationId})` : ""}`),
    ["Website form inquiries (CRM Lite)", inq.first ? `${day(inq.first)} – ${day(inq.latest)}` : "None", inq.latest ? `Last received ${stamp(inq.latest)}` : "None", "Not tracked", "Real time on form submit",
      <Pill key="i" state={inq.total ? "current" : "missing"}>{inq.total ? "Receiving" : "No inquiries"}</Pill>],
  ];

  const nextActions = [
    scope.problems.site && `Resolve the website mapping: ${scope.problems.site}`,
    thirdPartyLatest.length > 0 && `Correct organic matching so only ${siteHost} counts as the website (${thirdPartyLatest.length} of ${report.tracked} latest results matched a third-party page). The rank-sync fix in this pilot PR needs review and deployment; past checks are classified on read and not rewritten.`,
    organicHealth.state === "failed" && `The latest rank check failed (${organicHealth.lastProblem?.detail ?? "no detail"}). Figures are from ${day(organicHealth.lastSuccess?.at)}.`,
    mismatches.length > 0 && `Review ${plural(mismatches.length, "keyword")} where Google ranks a different page on the site than the intended owner page.`,
    latestScan && !comparison?.comparable && `A Maps trend needs a second scan with identical settings. ${comparison ? `The earlier scan is not comparable: ${comparison.reasons.join("; ")}.` : "Only one completed scan exists."}`,
    ga4.length > 0 && "Analytics imports all-channel sessions only. Organic sessions need a channel breakdown added to the GA4 import before organic traffic can be reported.",
    data.draftsInReview > 0 && `${plural(data.draftsInReview, "content draft is", "content drafts are")} waiting for review. Nothing is published until approved.`,
  ].filter(Boolean) as string[];

  return <div className="space-y-6">
    <div className="rounded-3xl bg-navy-900 p-6 text-white sm:p-8">
      <p className="text-[10px] font-bold uppercase tracking-[.22em] text-blue-200">Pilot report · for team review · not sent to the client</p>
      <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white">{data.client.name}: keywords to results</h2>
      <p className="mt-2 max-w-3xl text-sm text-blue-100/80">Built only from stored provider records. Opening this page calls no provider and starts no scan. Website rank, Google Maps rank and Search Console average position are separate measurements and are never mixed.</p>
      <div className="mt-5 flex flex-wrap gap-2 text-xs"><span className="rounded-full bg-white/10 px-3 py-1">Website {siteHost ?? "unresolved"}</span><span className="rounded-full bg-white/10 px-3 py-1">Read {stamp(now)}</span><Link href={`/clients/${clientId}/maps`} className="inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1">Maps dashboard <ArrowUpRight className="size-3"/></Link><Link href={`/clients/${clientId}/growth`} className="inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1">Growth dashboard <ArrowUpRight className="size-3"/></Link></div>
    </div>

    {scope.problems.brands && <Unavailable reason={scope.problems.brands}/>}

    <Section id="plain" kicker="In plain language" title="Where things stand">
      <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-slate-700">
        {siteHost && base && last && base !== last && <li>Of the {plural(cohort.size, "tracked keyword")} checked from the same location at the first scheduled check ({day(base.run.started_at)}) and the latest ({day(last.run.started_at)}), the website was in Google&apos;s top 10 for <strong>{cohort.top10Before}</strong> then and <strong>{cohort.top10After}</strong> now (top 3: {cohort.top3Before} → {cohort.top3After}). {cohort.improved} moved up, {cohort.declined} moved down, {cohort.unchanged} held, {cohort.entered} entered the top 100 and {cohort.dropped} dropped out.{cohort.excludedThirdParty > 0 && ` ${plural(cohort.excludedThirdParty, "keyword is", "keywords are")} left out because a directory or social page was matched instead of the website.`}</li>}
        {clicks.latest && <li>Search Console, {month(clicks.latest.period)}: <strong>{n(clicks.latest.values.search_clicks)}</strong> clicks and {n(impressions.latest?.values.search_impressions)} impressions ({signed(clicks.vsPrevious)} clicks vs {clicks.previous ? month(clicks.previous.period) : "no prior month"}). First imported month {clicks.first ? month(clicks.first.period) : "none"}: {n(clicks.first?.values.search_clicks)} clicks.</li>}
        {latestScan && <li>Google Maps scan {day(latestScan.started_at)}: {plural(latestScan.config.keywords.length, "keyword")} at {plural(latestScan.config.points.length, "point")}.{comparison?.comparable ? ` Compared with the ${day(priorScan!.started_at)} scan, which used identical settings.` : " No earlier scan with identical settings, so this is a starting point, not a trend."}</li>}
        <li>Website form inquiries: <strong>{inq.total}</strong>{inq.first ? ` since the first recorded inquiry on ${day(inq.first)}` : ""}. How each visitor found the site is not recorded.</li>
        <li>Work published: {published.length ? [...published.reduce((m, w) => m.set(w.kind, (m.get(w.kind) ?? 0) + 1), new Map<string, number>())].map(([k, c]) => `${c} ${k === "gbp" ? "Business Profile" : k === "social" ? "social" : "blog"} post${c === 1 ? "" : "s"}`).join(", ") : "none recorded"}. Work completed is shown next to results, but it does not prove it caused them.</li>
      </ul>
      {nextActions.length > 0 && <><h4 className="mt-5 text-sm font-semibold text-navy-900">Next actions</h4><ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-slate-700">{nextActions.map(a => <li key={a}>{a}</li>)}</ol></>}
    </Section>

    <Section id="health" kicker="Source health" title="What each number is based on">
      <Table caption="Source health" head={["Source", "Observation window", "Last successful refresh", "Last failed or partial attempt", "Schedule", "Status"]} rows={sources}/>
      <p className="mt-2 text-[11px] text-slate-500">Status reflects the latest attempt: a failure newer than the last success shows as failed, with the last success kept beside it. Freshness rules are the existing ones: ranks and map scans go stale after {RANK_STALE_DAYS} days; Search Console and Business Profile 45-day windows; Analytics a 7-day window with a 4-day provider delay. Schedules are the configured ones, not a promise that a run will happen. A missing source is unavailable, not zero. BrightLocal rank history is a different provider and is not mixed into these comparisons.</p>
    </Section>

    <Section id="organic" kicker="Website organic rank" title="Tracked keywords, check by check">
      {!siteHost ? <Unavailable reason={scope.problems.site ?? "The website host is unresolved."}/> : <>
      <Table caption="Organic results per check" head={["Check", "Keywords checked", "Website found", "Top 3", "Top 10", "Top 20", "Not in top 100", "Third-party match (excluded)"]}
        rows={perRun.map(p => [<span key="d">{day(p.run.started_at)}{p.run.id === cohort.baselineRun?.id && <span className="block font-normal text-blue-700">Baseline (first scheduled check)</span>}{p.beforeBaseline && <span className="block font-normal text-slate-500">{p.run.triggered_by === "cron" ? "Scheduled" : "Manual"}, before baseline</span>}</span>, p.keywords, p.verified - p.notFound, p.top3, p.top10, p.top20, p.notFound, p.thirdParty])}/>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{plural(report.tracked, "keyword is", "keywords are")} selected for tracking. They are not every query Google shows the site for. Counts are keywords, one observation each per check. Top 10 includes top 3. A third-party match means a directory, social or review page with the business name ranked before the website; the website&apos;s own position for that check is unknown, so it is never counted.{report.duplicates > 0 && ` ${report.duplicates} duplicate observations were ignored.`}</p>
      <div className="mt-4 rounded-xl bg-slate-50 p-4 text-xs leading-relaxed text-slate-700"><strong>Stable comparison group:</strong> {plural(cohort.size, "keyword")} checked from the same location record at the baseline and the latest complete check. {cohort.excludedThirdParty} excluded for a third-party match, {cohort.excludedMissing} excluded as missing from one of the two checks. Up {cohort.improved} · down {cohort.declined} · held {cohort.unchanged} · entered top 100 {cohort.entered} · dropped out {cohort.dropped} · not in top 100 either time {cohort.absentBoth}.</div>
      <p className="mt-3 text-[11px] leading-relaxed text-amber-800"><strong>Comparability is inferred, not proven.</strong> Search engine, device, depth and coordinates are not stored with each check. Checks are treated as comparable when they share the location record and the tracker&apos;s current settings (Google, desktop, top 100, by the location&apos;s coordinates).{earlyRuns.length > 0 && ` ${plural(earlyRuns.length, "earlier check")} (${earlyRuns.map(p => day(p.run.started_at)).join(", ")}) ran while the tracker was being set up and may have used different settings, so ${earlyRuns.length === 1 ? "it is" : "they are"} shown but not used as the baseline.`}</p>
      </>}
    </Section>

    <Section id="keywords" kicker="Keyword table" title="Each tracked keyword">
      {!siteHost ? <Unavailable reason={scope.problems.site ?? "The website host is unresolved."}/> : <>
      <Table caption="Tracked keyword ranking detail" head={["Keyword", "Service · intent", "Intended page", "Ranking page (latest)", "Baseline", "Latest check", "Movement", "Status"]}
        rows={report.rows.map(r => [
          <span key="k">{r.keyword}{r.is_money && <span className="ml-1 rounded bg-orange-50 px-1 text-[10px] text-orange-700">money</span>}<span className="mt-0.5 block font-normal text-slate-500">{locationName(r.location_id)} · Google desktop · top 100</span></span>,
          <span key="s">{r.service ?? "No service linked"}<span className="block text-slate-500">{r.intent ?? "intent not set"}</span></span>,
          path(r.target_url),
          r.latest?.state === "ranked" ? <span key="u" className={r.pageMismatch ? "font-semibold text-amber-700" : ""}>{path(r.latest.url_ranked)}{r.pageMismatch && <span className="block font-normal">Differs from intended page, review</span>}</span>
            : r.latest?.state === "third_party" ? <span key="u" className="text-amber-700">{hostOf(r.latest.url_ranked)}<span className="block">Not the website</span></span> : "—",
          <span key="b">{r.baseline ? obsText(r.baseline) : "No baseline"}<span className="block text-slate-500">{r.baseline ? day(r.baseline.recorded_at) : ""}{r.baselineLate && " (added after baseline)"}</span></span>,
          <span key="l">{obsText(r.latest)}<span className="block text-slate-500">{r.latest ? day(r.latest.recorded_at) : ""}</span></span>,
          <span key="m" className={tone(r.movement.kind)}>{r.movement.label}</span>,
          <Pill key="st" state={r.status === "current" ? "current" : r.status}>{r.status === "not_checked" ? "Not checked" : r.status[0].toUpperCase() + r.status.slice(1)}</Pill>,
        ])}/>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">Baseline is the keyword&apos;s result at the first scheduled check (or its first later check if it was added afterwards), from the same location record. It is the first observed baseline, not a pre-engagement baseline. Lower is better. Ranking pages are reported as observed and are never remapped.</p>
      </>}
    </Section>

    <Section id="maps" kicker="Google Maps" title="Map rankings (separate from the website)">
      {!grid ? <Unavailable reason={data.grids.length > 1 ? `${data.grids.length} map profiles exist; the pilot reports one.` : "No map profile is set up for this client."}/> : latestScan ? <>
        <Table caption="Latest map scan by radius" head={["Keyword", "Within 1 mi", "Within 2 mi", "Within 5 mi", "Full scan"]} rows={mapRows}/>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">Scan {stamp(latestScan.started_at)} · geometry {geom(latestScan.config)?.version ?? "unknown"} · {plural(latestScan.config.points.length, "point")} · search mode {latestScan.config.search_this_area === undefined || latestScan.config.search_this_area === null ? "unknown" : latestScan.config.search_this_area ? "search this area" : "standard"} · zoom {latestScan.config.zoom ?? "unknown"}. Radius is distance from the {center ? "recorded center" : "center (not recorded)"}. Percent in top 3 uses completed points only; the average excludes points where the business was not found. No points are interpolated.</p>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-700">{!priorScan ? "Only one completed scan exists, so there is no comparison." : comparison!.comparable ? `Prior values are from the ${day(priorScan.started_at)} scan, which used identical business, search mode, zoom, geometry, points and keywords.` : `The earlier scan (${day(priorScan.started_at)}) is not compared: ${comparison!.reasons.join("; ")}.`}</p>
      </> : <p className="text-sm text-muted-foreground">No completed map scan.</p>}
      {siteHost && base && last && <p className="mt-3 text-xs text-slate-700">Local pack in normal Google results, checked from the home location record: in the top 3 for {report.rows.filter(r => r.mapPack.baseline && r.mapPack.baseline.position !== null && r.mapPack.baseline.position <= 3).length} of {report.rows.filter(r => r.mapPack.baseline).length} keywords at the baseline and {report.rows.filter(r => r.mapPack.latest && r.mapPack.latest.position !== null && r.mapPack.latest.position <= 3).length} of {report.rows.filter(r => r.mapPack.latest).length} at the latest check.</p>}
      <Link href={`/clients/${clientId}/maps`} className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-blue-700">Open the Maps dashboard (radius controls, history) <ArrowUpRight className="size-3"/></Link>
    </Section>

    <Section id="traffic" kicker="Traffic" title="Search Console, Analytics and Business Profile">
      <h4 className="mb-2 text-sm font-semibold">Search Console: property totals</h4>
      {scope.problems.gsc ? <Unavailable reason={scope.problems.gsc}/> : <MonthTable caption="Search Console monthly totals" points={gsc} cols={[["search_clicks", "Clicks"], ["search_impressions", "Impressions"]]} note={`Property ${scope.gscProperty} only. Complete calendar months, imported daily. Property totals, not only tracked keywords. Search Console average position is a different measure from the rank checks above and is not shown as a rank.`}/>}
      <h4 className="mb-2 mt-5 text-sm font-semibold">Analytics 4: website sessions, all channels</h4>
      {scope.problems.ga4 ? <Unavailable reason={scope.problems.ga4}/> : <MonthTable caption="Analytics monthly sessions" points={ga4} cols={[["website_sessions", "Sessions"], ["website_users", "Users"]]} note={`Property ${scope.ga4Property}, receipts whose recorded host is ${siteHost} only. These are all-channel sessions; organic sessions are not imported yet. Month to date runs about 4 days behind. Latest complete month: ${sessions.latest ? `${month(sessions.latest.period)} ${n(sessions.latest.values.website_sessions)} sessions (${signed(sessions.vsPrevious)} vs prior month)` : "none"}.`}/>}
      <h4 className="mb-2 mt-5 text-sm font-semibold">Business Profile actions</h4>
      {scope.problems.gbp ? <Unavailable reason={scope.problems.gbp}/> : <MonthTable caption="Business Profile monthly actions" points={gbp} cols={[["calls", "Call clicks"], ["website", "Website clicks"], ["directions", "Direction requests"], ["views", "Profile views"]]} note={`Location ${scope.gbp!.locationId} only. Interactions recorded by Google, not unique leads or customers. One person can produce several actions.`}/>}
    </Section>

    <Section id="inquiries" kicker="Inquiries" title="Captured website inquiries">
      {inq.total ? <div className="grid gap-5 md:grid-cols-3">
        <Table caption="Inquiries by month" head={["Month (Central)", "Inquiries"]} rows={inq.byMonth}/>
        <Table caption="Inquiries by page" head={["Page submitted from", "Inquiries"]} rows={inq.byPage}/>
        <Table caption="Inquiries by form" head={["Form", "Inquiries"]} rows={inq.byForm}/>
      </div> : <p className="text-sm text-muted-foreground">No inquiries captured.</p>}
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">Counts every submission received. Internal tests are not marked in the data, so they may be included. The form records the page, not the traffic source, so no inquiry is attributed to a keyword, to organic search or to revenue. Roofing and holiday lighting forms are kept separate.</p>
    </Section>

    <Section id="work" kicker="Work performed" title="Published work">
      {published.length ? <Table caption="Published work" head={["Published", "Type", "Link"]} rows={published.map(w => [day(w.published_on), w.title, w.url ? <a key="u" href={w.url} target="_blank" rel="noreferrer" className="text-blue-700 underline">View</a> : "No link"])}/> : <p className="text-sm text-muted-foreground">No published work recorded.</p>}
      <p className="mt-2 text-[11px] text-slate-500">Published items only, dated by their verified publish time. {plural(data.draftsInReview, "draft")} in review {data.draftsInReview === 1 ? "is" : "are"} not counted. This is agency activity, shown separately from results.</p>
    </Section>
  </div>;
}
