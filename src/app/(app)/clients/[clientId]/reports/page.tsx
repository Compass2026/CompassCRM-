import { createClient } from "@/lib/supabase/server";
import { toggleTaskAction } from "@/app/actions";
import { startCycleAction, updateCycleAction } from "@/app/tracker-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ownerLabels } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { ClientScorecard } from "@/components/client-scorecard";
import { loadReportMeasurements } from "@/lib/reporting-data";
import { reportingMonths, validDate } from "@/lib/reporting";

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ scorecard_month?: string; scorecard_view?: string }>;
}) {
  const { clientId } = await params;
  const query = await searchParams;
  const supabase = await createClient();

  const [{ data: cycles }, { data: client }, { data: contentPosts }, { data: socialPosts }, measurements] =
    await Promise.all([
      supabase
        .from("monthly_cycles")
        .select("*, tasks(id, title, owner, status)")
        .eq("client_id", clientId)
        .order("period", { ascending: false }),
      supabase.from("clients").select("status").eq("id", clientId).single(),
      supabase
        .from("content_posts")
        .select("published_at")
        .eq("client_id", clientId)
        .eq("status", "published"),
      supabase
        .from("social_posts")
        .select("scheduled_at")
        .eq("client_id", clientId)
        .eq("status", "published"),
      loadReportMeasurements(supabase, clientId),
    ]);

  // Monthly cycles are created on UTC months (startCycleAction, pg_cron), so
  // the cycle list keeps that month. The scorecard's default data month uses
  // Compass's day (America/Chicago), like every other user-facing "today".
  const months = reportingMonths();
  const thisMonthFirst = months.cycleMonthFirst;
  const scorecardMonthFirst = months.scorecardMonthFirst;
  const requestedPeriod = typeof query.scorecard_month === "string" ? `${query.scorecard_month}-01` : "";
  const latestDataMonth = measurements.rows.map((row) => `${row.window_end.slice(0, 7)}-01`).sort().at(-1);
  const period = validDate(requestedPeriod) ? requestedPeriod : latestDataMonth ?? scorecardMonthFirst;
  const baselineOnly = query.scorecard_view === "baseline" ||
    (query.scorecard_view !== "monthly" && !measurements.rows.some((row) => row.report_period));
  const hasCurrentCycle = (cycles ?? []).some((c) => c.period === thisMonthFirst);
  const startCycle = startCycleAction.bind(null, clientId);

  function countInMonth(dates: (string | null)[], period: string) {
    const prefix = period.slice(0, 7);
    return dates.filter((d) => d?.startsWith(prefix)).length;
  }

  return (
    <div className="space-y-4">
      {measurements.error ? <p role="alert" className="surface p-4 text-sm">{measurements.error}</p> :
        <ClientScorecard clientId={clientId} rows={measurements.rows} period={period} baselineOnly={baselineOnly} />}
      <details className="surface p-4 sm:p-5 space-y-4">
        <summary className="cursor-pointer font-semibold text-navy-900">
          Monthly workflow & earlier reports
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {(cycles ?? []).length} cycle{(cycles ?? []).length === 1 ? "" : "s"} · open cycle tasks, including Send report, are here
          </span>
        </summary>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          One card per monthly Reporting cycle. Cycles are named by their UTC
          month and open automatically on the 1st at 06:00 UTC (1 am Central in
          summer, midnight in winter) for active clients; each cycle reports the
          previous month&apos;s data. The button covers mid-month starts.
        </p>
        {!hasCurrentCycle && (
          <form action={startCycle}>
            <Button type="submit" variant="outline" size="sm">
              Start {thisMonthFirst.slice(0, 7)} cycle (UTC month)
            </Button>
          </form>
        )}
      </div>
      {months.differ && (
        <p role="note" className="callout border-amber-200 bg-amber-50 text-xs text-amber-900">
          It&apos;s already {thisMonthFirst.slice(0, 7)} in UTC, so the cycle month has
          turned over, but it&apos;s still {scorecardMonthFirst.slice(0, 7)} in Central
          time, which the scorecard uses. The two line up again at midnight Central.
        </p>
      )}

      {(cycles ?? []).length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No monthly cycles yet
            {client?.status !== "active" &&
              ". Cycles begin once the client converges to active/Reporting"}
            .
          </CardContent>
        </Card>
      )}

      {(cycles ?? []).map((cycle) => {
        const doneTasks = cycle.tasks.filter((t) => t.status === "done").length;
        const rank = cycle.rank_summary as {
          organic_index?: number;
          map_index?: number;
          note?: string;
        } | null;
        const summary = cycle.summary as {
          wins?: string[];
          next_month?: string[];
          gsc?: { clicks?: number; impressions?: number; prev?: { clicks?: number; impressions?: number } };
          ranks?: { tracked?: number; up?: number; down?: number; top3?: number; top10?: number };
          backlinks?: { referring_domains?: number; prev?: number };
          gbp?: { rating?: number; reviews?: number; prev_reviews?: number };
        } | null;
        const delta = (now?: number, prev?: number) =>
          now == null || prev == null ? "" : ` (${now - prev >= 0 ? "+" : ""}${now - prev})`;
        return (
          <Card key={cycle.id}>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <CardTitle className="text-base">
                  {cycle.period.slice(0, 7)}
                </CardTitle>
                <Badge
                  variant="outline"
                  className={
                    cycle.status === "complete"
                      ? "bg-green-100 text-green-800 border-green-200"
                      : "bg-blue-100 text-blue-800 border-blue-200"
                  }
                >
                  {cycle.status}
                </Badge>
                <span className="text-xs text-muted-foreground ml-auto">
                  {doneTasks}/{cycle.tasks.length} tasks ·{" "}
                  {countInMonth(contentPosts?.map((p) => p.published_at) ?? [], cycle.period)}{" "}
                  blog ·{" "}
                  {countInMonth(socialPosts?.map((p) => p.scheduled_at) ?? [], cycle.period)}{" "}
                  social marked published (scheduled month)
                </span>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {rank && (
                <p className="text-xs text-muted-foreground">
                  Rank summary: organic index {rank.organic_index ?? "—"} · map
                  index {rank.map_index ?? "—"}
                  {rank.note ? ` · ${rank.note}` : ""}
                </p>
              )}
              {summary && (
                <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1">
                  <p className="font-medium">Earlier summary. These figures have not been verified as baseline measurements.</p>
                  <p className="text-muted-foreground">
                    {summary.ranks && (
                      <>
                        Ranks: {summary.ranks.up ?? "Not measured"} up · {summary.ranks.down ?? "Not measured"} down · top 3 {summary.ranks.top3 ?? "Not measured"} · top 10 {summary.ranks.top10 ?? "Not measured"}
                        {" · "}
                      </>
                    )}
                    {summary.gsc && (
                      <>
                        Search Console: {summary.gsc.clicks ?? "—"} clicks{delta(summary.gsc.clicks, summary.gsc.prev?.clicks)} · {summary.gsc.impressions ?? "—"} impressions{delta(summary.gsc.impressions, summary.gsc.prev?.impressions)}
                        {" · "}
                      </>
                    )}
                    {summary.backlinks && (
                      <>
                        {summary.backlinks.referring_domains ?? "—"} referring domains{delta(summary.backlinks.referring_domains, summary.backlinks.prev)}
                        {" · "}
                      </>
                    )}
                    {summary.gbp && (
                      <>
                        GBP {summary.gbp.rating ?? "—"}★ {summary.gbp.reviews ?? "—"} reviews{delta(summary.gbp.reviews, summary.gbp.prev_reviews)}
                      </>
                    )}
                  </p>
                  {summary.wins && summary.wins.length > 0 && (
                    <ul className="list-disc pl-4">
                      {summary.wins.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  )}
                  {summary.next_month && summary.next_month.length > 0 && (
                    <p className="text-muted-foreground">Next: {summary.next_month.join(" · ")}</p>
                  )}
                </div>
              )}
              {cycle.report_url && (
                <a href={cycle.report_url} target="_blank" rel="noreferrer" className="text-primary text-sm hover:underline">
                  Monthly report (Drive)
                </a>
              )}

              <ul className="space-y-1">
                {cycle.tasks.map((task) => (
                  <li key={task.id} className="flex items-center gap-2 text-sm">
                    <form
                      action={toggleTaskAction.bind(
                        null,
                        clientId,
                        task.id,
                        task.status !== "done"
                      )}
                    >
                      <button
                        type="submit"
                        className={cn(
                          "size-4 rounded border border-input",
                          task.status === "done" && "bg-primary"
                        )}
                        title={task.status === "done" ? "Reopen" : "Mark done"}
                      />
                    </form>
                    <span
                      className={cn(
                        task.status === "done" && "line-through text-muted-foreground"
                      )}
                    >
                      {task.title}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {ownerLabels[task.owner]}
                    </Badge>
                  </li>
                ))}
              </ul>

              <form
                action={updateCycleAction.bind(null, clientId, cycle.id)}
                className="flex gap-2 flex-wrap border-t pt-3"
              >
                <Input
                  name="report_url"
                  placeholder="Report Drive link"
                  defaultValue={cycle.report_url ?? ""}
                  className="h-8 flex-1 min-w-48 text-xs"
                />
                <Textarea
                  name="notes"
                  placeholder="Cycle notes"
                  defaultValue={cycle.notes ?? ""}
                  rows={1}
                  className="text-xs flex-1 min-w-48"
                />
                <select
                  name="status"
                  defaultValue={cycle.status}
                  className="field-sm"
                >
                  <option value="open">open</option>
                  <option value="complete">complete</option>
                </select>
                <Button type="submit" size="sm" variant="outline">
                  Save
                </Button>
              </form>
            </CardContent>
          </Card>
        );
      })}
      </details>
    </div>
  );
}
