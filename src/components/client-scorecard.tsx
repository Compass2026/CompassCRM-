import { REPORT_AREAS, formatMeasurement, previousMonth, scorecardRows, type Measurement } from "@/lib/reporting";
import { ReportMeasurementForm } from "@/components/report-measurement-form";
import { buttonVariants } from "@/components/ui/button";

function Value({ row }: { row?: Measurement }) {
  return <><span className="font-medium">{formatMeasurement(row)}</span>{row && <span className="mt-1 block text-xs text-muted-foreground">{row.window_start === row.window_end ? row.window_end : `${row.window_start} to ${row.window_end}`}</span>}</>;
}

export function ClientScorecard({ clientId, rows, period, baselineOnly = false }: { clientId: string; rows: Measurement[]; period: string; baselineOnly?: boolean }) {
  const series = scorecardRows(rows, clientId, period);
  const measuredAreas = REPORT_AREAS.filter((area) => series.some((s) => area.metrics.some(([key]) => key === s.definition.metric) && (baselineOnly ? s.baseline : s.current)?.status === "measured")).length;
  return <section className="space-y-4" aria-label="Client marketing scorecard">
    <div className="surface-tint p-4 sm:p-6 space-y-2">
      <p className="eyebrow">Marketing scorecard</p>
      <h2 className="text-xl font-bold tracking-tight">{baselineOnly ? "Starting baseline" : `${period.slice(0, 7)} marketing scorecard`}</h2>
      <p className="text-sm">{measuredAreas} of 9 areas have verified measurements{baselineOnly ? " available by this month" : " for this month"}. Open an area to review its numbers and next actions.</p>
      <p className="text-sm text-muted-foreground">Capture the starting point during onboarding, before improvements. For an existing client, use the first available measurement and its real date. Missing data never counts as zero.</p>
      <p className="text-sm text-muted-foreground">Data months and dates here use Compass&apos;s day (Central time). Monthly Reporting cycles below are named by UTC month and report the previous month.</p>
      <p className="text-sm text-muted-foreground"><strong className="font-medium text-foreground">Recorded by hand.</strong> Every number here was entered with its source and evidence, by a team member or by the worker. The scorecard does not read the rank-tracking or Search Console snapshots on its own; those stay in their trackers until someone records a verified figure here.</p>
      <form className="flex flex-wrap items-end gap-2 print:hidden">
        <label className="text-sm">Data month (Central)<input aria-label="Data month" name="scorecard_month" type="month" defaultValue={period.slice(0, 7)} className="field ml-2" required /></label>
        <label className="text-sm">View<select name="scorecard_view" defaultValue={baselineOnly ? "baseline" : "monthly"} className="field ml-2"><option value="monthly">Monthly progress</option><option value="baseline">Starting baseline</option></select></label>
        <button type="submit" className={buttonVariants({ variant: "default" })}>Show</button>
      </form>
    </div>
    <div className="grid gap-3">
      {REPORT_AREAS.map((area, index) => {
        const areaSeries = series.filter((s) => area.metrics.some(([key]) => key === s.definition.metric));
        const measured = areaSeries.filter((s) => (baselineOnly ? s.baseline : s.current)?.status === "measured").length;
        return <details key={area.key} className="min-w-0 surface p-4 sm:p-5" open={measured > 0}>
          <summary className="cursor-pointer"><span className="font-semibold text-navy-900">{index + 1}. {area.label}</span>{measured ? <span className="ml-3 rounded-full bg-royal-100 px-2 py-0.5 text-xs font-semibold text-royal-700">{measured} measured</span> : <span className="ml-3 text-xs text-muted-foreground">No verified measurements yet</span>}</summary>
          <p className="mt-3 text-sm text-muted-foreground">{area.next}</p>
          <div className="overflow-x-auto mt-3">
            <table className="w-full text-sm">
              <caption className="sr-only">{area.label}: baseline{!baselineOnly && ", prior period and current period"}</caption>
              <thead><tr className="border-b bg-royal-50/80 text-left text-xs font-semibold text-muted-foreground"><th className="p-2 min-w-48">Metric / scope</th><th className="p-2 min-w-28">Baseline</th>{!baselineOnly && <><th className="p-2 min-w-28">Previous ({previousMonth(period).slice(0, 7)})</th><th className="p-2 min-w-28">Current ({period.slice(0, 7)})</th><th className="p-2 min-w-32">Change</th></>}</tr></thead>
              <tbody>{area.metrics.flatMap(([key, label]) => {
                const matches = areaSeries.filter((s) => s.definition.metric === key);
                if (!matches.length) return <tr key={key} className="border-b align-top"><th scope="row" className="p-2 text-left font-normal">{label}</th><td className="p-2 text-muted-foreground">Not measured</td>{!baselineOnly && <><td className="p-2 text-muted-foreground">Not measured</td><td className="p-2 text-muted-foreground">Not measured</td><td className="p-2 text-muted-foreground">Measurements needed</td></>}</tr>;
                return matches.map((s) => {
                  const note = baselineOnly ? s.baseline ?? s.history[0] : s.current;
                  const changeText = (delta: number | null) => delta === null ? "Not comparable" : `${delta > 0 ? "+" : ""}${delta}`;
                  return <tr key={s.key} className="border-b align-top">
                    <th scope="row" className="p-2 text-left font-normal">
                      <span className="font-medium">{label}</span>
                      <span className="block text-xs text-muted-foreground">{s.definition.scope}{s.definition.platform !== "none" && ` · ${s.definition.platform} · ${s.definition.channel}`} · {s.definition.source}</span>
                      <p className="mt-2 text-xs">{note?.meaning ?? "No measurement recorded for this month."}</p>
                      <p className="mt-1 text-xs"><strong>Next:</strong> {note?.next_action ?? area.next}</p>
                      <details className="mt-2 text-xs print:hidden"><summary className="cursor-pointer text-muted-foreground">Evidence & history ({s.history.length})</summary><ul className="mt-2 space-y-2">{[...s.history].reverse().map((entry) => <li key={entry.id} className="border-l pl-2"><p>{entry.window_start} to {entry.window_end}: {formatMeasurement(entry)}{entry.id === s.baseline?.id ? " · Original baseline" : ""}</p><p>{entry.evidence || entry.meaning}</p><p className="text-muted-foreground">Recorded {entry.created_at.slice(0, 10)} · {entry.report_period?.slice(0, 7) ?? "Initial measurement"}</p></li>)}</ul></details>
                    </th>
                    <td className="p-2"><Value row={s.baseline} />{s.baseline && <span className="mt-1 block text-xs text-muted-foreground">{s.baseline.context === "before_work" ? "Before improvements" : "First available; work already started"}</span>}</td>
                    {!baselineOnly && <><td className="p-2"><Value row={s.previous} /></td><td className="p-2"><Value row={s.current} /></td><td className="p-2 text-xs"><p title={s.change.reason}>vs previous: {changeText(s.change.delta)}</p><p className="mt-1" title={s.sinceBaseline.reason}>vs baseline: {changeText(s.sinceBaseline.delta)}</p><p className="mt-1 text-muted-foreground">{s.change.reason}</p></td></>}
                  </tr>;
                });
              })}</tbody>
            </table>
          </div>
        </details>;
      })}
    </div>
    <div className="print:hidden"><ReportMeasurementForm clientId={clientId} period={period} series={series.map((s) => s.definition)} /></div>
  </section>;
}
