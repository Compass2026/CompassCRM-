import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MonthlyReportView } from "@/components/monthly-report";
import { buildMonthlyReport, reportPeriods } from "@/lib/monthly-report";
import { loadMonthlyReportInput } from "@/lib/monthly-report-data";

// An unsaved preview: the same calculation Generate freezes, computed now and
// thrown away. It is never a version, never approved and never delivered.
export default async function MonthlyReportPreviewPage({ params, searchParams }: { params: Promise<{ clientId: string }>; searchParams: Promise<{ period?: string }> }) {
  const { clientId } = await params;
  const now = new Date().toISOString();
  const months = reportPeriods(now, 6);
  const { period: asked } = await searchParams;
  const period = asked && months.includes(asked) ? asked : months[0];
  const loaded = await loadMonthlyReportInput(await createClient(), clientId, period, now);
  if (loaded.error === "not_found") notFound();
  return <div className="space-y-4">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <p className="text-xs text-muted-foreground"><Link className="underline" href={`/clients/${clientId}/reports/monthly`}>Monthly reports</Link> / Preview</p>
      <div className="flex gap-3 text-sm">{months.map(m => <Link key={m} className={m === period ? "font-semibold" : "underline"} href={`?period=${m}`}>{m.slice(0, 7)}</Link>)}
        <Link className="underline" href={`/clients/${clientId}/reports/monthly/preview/print?period=${period}`} target="_blank">Print</Link></div>
    </div>
    <p role="note" className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">Preview, not saved: computed from stored records just now. Generate a draft to freeze it as a version for review.</p>
    {loaded.error !== null ? <p role="alert" className="surface p-4 text-sm">{loaded.error}</p> : (() => {
      const { defaultEditorial, ...snapshot } = buildMonthlyReport(loaded.data, period, now);
      return <MonthlyReportView report={snapshot} editorial={defaultEditorial} version={0} status="preview" contentHash="not saved"/>;
    })()}
  </div>;
}
