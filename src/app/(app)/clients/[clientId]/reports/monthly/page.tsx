import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { monthOfPeriod, reportPeriods } from "@/lib/monthly-report";
import { generateMonthlyReportAction } from "@/app/monthly-report-actions";

const TZ = "America/Chicago";
const stamp = (s: string | null) => s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ, timeZoneName: "short" }) : "—";
const statusText: Record<string, string> = { draft: "Draft", in_review: "In review", approved: "Approved", superseded: "Superseded", discarded: "Discarded" };

// Team-only. Generating freezes the month's stored records into a new draft
// version; nothing is sent and no provider is called.
// Action errors arrive as ?error= and are shown by the app's ActionFeedback.
export default async function MonthlyReportsPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const db = await createClient();
  const now = new Date().toISOString();
  const [{ data: client }, { data: versions, error: readError }, { data: deliveries }] = await Promise.all([
    db.from("clients").select("id,name").eq("id", clientId).maybeSingle(),
    db.from("monthly_reports").select("id,period,version,status,cutoff,is_partial,completeness,generated_at,approved_at,correction_reason").eq("client_id", clientId).order("period", { ascending: false }).order("version", { ascending: false }),
    db.from("monthly_report_deliveries").select("report_id,outcome,destination,recorded_at").eq("client_id", clientId),
  ]);
  if (!client) notFound();
  const months = reportPeriods(now, 6);
  const byPeriod = new Map<string, NonNullable<typeof versions>>();
  for (const v of versions ?? []) byPeriod.set(v.period, [...(byPeriod.get(v.period) ?? []), v]);
  const sent = new Set((deliveries ?? []).filter(d => d.outcome === "sent").map(d => d.report_id));

  return <div className="space-y-5">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h2 className="text-lg font-semibold">Monthly reports</h2>
        <p className="text-sm text-muted-foreground">Each version freezes the month&apos;s figures. Review, approve for one destination and recipients, then record what you sent. Nothing is sent from here.</p>
      </div>
      <div className="flex gap-3 text-sm"><Link href={`/clients/${clientId}/reports/monthly/preview`} className="underline">Preview this month (not saved)</Link><Link href={`/clients/${clientId}/reports`} className="underline">Back to Reports</Link></div>
    </div>
    {readError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">Reports could not be loaded ({readError.code}).</p>}

    <form action={generateMonthlyReportAction.bind(null, clientId)} className="surface grid gap-3 p-4 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
      <input type="hidden" name="request_key" value={crypto.randomUUID()}/>
      <div className="space-y-1">
        <Label htmlFor="period">Month</Label>
        <select id="period" name="period" className="field w-full" defaultValue={months[0]}>
          {months.map((m, i) => <option key={m} value={m}>{monthOfPeriod(m).label}{i === 0 ? " (in progress — partial preview)" : ""}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="correction_reason">Correction reason (only when replacing an approved version)</Label>
        <Input id="correction_reason" name="correction_reason" maxLength={2000} placeholder="e.g. Business Profile import arrived late"/>
      </div>
      <Button type="submit">Generate draft</Button>
    </form>

    {months.concat([...byPeriod.keys()].filter(p => !months.includes(p))).filter(p => byPeriod.has(p)).map(p => <section key={p} className="surface p-4" aria-labelledby={`m-${p}`}>
      <h3 id={`m-${p}`} className="font-semibold">{monthOfPeriod(p).label}</h3>
      <table className="mt-2 w-full text-left text-sm">
        <caption className="sr-only">Versions for {monthOfPeriod(p).label}</caption>
        <thead><tr className="text-xs text-muted-foreground"><th scope="col" className="p-1">Version</th><th scope="col" className="p-1">Status</th><th scope="col" className="p-1">Data as of</th><th scope="col" className="p-1">Generated</th><th scope="col" className="p-1">Notes</th></tr></thead>
        <tbody>{byPeriod.get(p)!.map(v => <tr key={v.id} className="border-t">
          <th scope="row" className="p-1 font-medium"><Link className="underline" href={`/clients/${clientId}/reports/monthly/${v.id}`}>v{v.version}</Link></th>
          <td className="p-1">{statusText[v.status] ?? v.status}{sent.has(v.id) ? " · delivered" : ""}</td>
          <td className="p-1">{stamp(v.cutoff)}{v.is_partial ? " (partial)" : ""}</td>
          <td className="p-1">{stamp(v.generated_at)}</td>
          <td className="p-1 text-muted-foreground">{[v.completeness === "incomplete" && !v.is_partial ? "missing sources" : null, v.correction_reason ? `Correction: ${v.correction_reason}` : null].filter(Boolean).join(" · ") || "—"}</td>
        </tr>)}</tbody>
      </table>
    </section>)}
    {!versions?.length && !readError && <p className="text-sm text-muted-foreground">No versions yet for {client.name}.</p>}
  </div>;
}
