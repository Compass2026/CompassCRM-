import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatDate,
  formatMonth,
  formatNumber,
  progressStatusLabels,
  progressStatusStyles,
  stageLabel,
  workLabel,
} from "@/lib/portal";

export default async function PortalOverviewPage() {
  const supabase = await createClient();

  const [
    { data: client },
    { data: progress },
    { data: rankings },
    { data: search },
    { data: work },
    { data: reports },
    { data: site },
  ] = await Promise.all([
    supabase.from("portal_client").select("*").maybeSingle(),
    supabase.from("portal_progress").select("*"),
    supabase.from("portal_rankings").select("*").eq("result_type", "organic"),
    supabase
      .from("portal_search_performance")
      .select("*")
      .order("period_end", { ascending: false })
      .limit(1),
    supabase
      .from("portal_work_log")
      .select("*")
      .order("at", { ascending: false, nullsFirst: false })
      .limit(5),
    supabase
      .from("portal_reports")
      .select("period, report_url")
      .order("period", { ascending: false })
      .limit(1),
    supabase.from("portal_site").select("*").maybeSingle(),
  ]);

  const tracked = rankings ?? [];
  const ranked = tracked.filter((r) => r.position != null);
  const top3 = ranked.filter((r) => (r.position ?? 99) <= 3).length;
  const top10 = ranked.filter((r) => (r.position ?? 99) <= 10).length;
  const improved = tracked.filter(
    (r) =>
      r.position != null &&
      r.previous_position != null &&
      r.previous_position > r.position
  ).length;

  const latestSearch = (search ?? [])[0];
  const latestReport = (reports ?? [])[0];
  const inProgress = (progress ?? []).filter((p) => p.status === "in_progress");
  const checkedAt = tracked
    .map((r) => r.checked_at)
    .filter(Boolean)
    .sort()
    .at(-1);

  const stats = [
    { label: "Keywords tracked", value: formatNumber(tracked.length) },
    { label: "In the top 3", value: formatNumber(top3) },
    { label: "In the top 10", value: formatNumber(top10) },
    { label: "Moved up this week", value: formatNumber(improved) },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="page-title kicker mb-1">{client?.name}</h1>
        <p className="text-sm text-muted-foreground">
          Your marketing at a glance
          {checkedAt ? ` · rankings last checked ${formatDate(checkedAt)}` : ""}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardContent className="pt-6">
              <div className="text-3xl font-heading font-semibold">
                {stat.value}
              </div>
              <div className="text-sm text-muted-foreground mt-1">
                {stat.label}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Search traffic</CardTitle>
          </CardHeader>
          <CardContent>
            {latestSearch ? (
              <>
                <div className="flex gap-8">
                  <div>
                    <div className="text-2xl font-heading font-semibold">
                      {formatNumber(latestSearch.clicks)}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      visits from Google
                    </div>
                  </div>
                  <div>
                    <div className="text-2xl font-heading font-semibold">
                      {formatNumber(latestSearch.impressions)}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      times you appeared
                    </div>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-3">
                  {formatDate(latestSearch.period_start)} –{" "}
                  {formatDate(latestSearch.period_end)} ·{" "}
                  <Link href="/portal/search" className="underline">
                    see the searches
                  </Link>
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Google Search Console data lands here after the first full
                month of tracking.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Your website</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            {site?.url ? (
              <p>
                <a
                  href={site.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  {site.url.replace(/^https?:\/\//, "")}
                </a>
              </p>
            ) : (
              <p className="text-muted-foreground">Website in progress.</p>
            )}
            {site?.launched_at && (
              <p className="text-muted-foreground">
                Launched {formatDate(site.launched_at)}
              </p>
            )}
            {site?.last_pushed_at && (
              <p className="text-muted-foreground">
                Last updated {formatDate(site.last_pushed_at)}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {inProgress.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">What we&apos;re working on</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {inProgress.map((p) => (
              <div
                key={`${p.pipeline}-${p.stage}`}
                className="flex items-center justify-between text-sm"
              >
                <span>{stageLabel(p.stage)}</span>
                <Badge
                  variant="outline"
                  className={progressStatusStyles[p.status ?? ""] ?? ""}
                >
                  {progressStatusLabels[p.status ?? ""] ?? p.status}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recent work</CardTitle>
          </CardHeader>
          <CardContent>
            {(work ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Work shows up here as it is published.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {(work ?? []).map((w, i) => (
                  <li key={i} className="flex justify-between gap-4">
                    <span>{workLabel(w.kind, w.label)}</span>
                    <span className="text-muted-foreground whitespace-nowrap">
                      {formatDate(w.at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground mt-3">
              <Link href="/portal/work-log" className="underline">
                See everything
              </Link>
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Monthly report</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {latestReport?.report_url ? (
              <a
                href={latestReport.report_url}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {formatMonth(latestReport.period)} report
              </a>
            ) : (
              <p className="text-muted-foreground">
                Your first monthly report arrives at the start of next month.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
