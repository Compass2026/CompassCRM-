import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MonthlyReportView } from "@/components/monthly-report";
import { buildMonthlyReport, reportPeriods } from "@/lib/monthly-report";
import { loadMonthlyReportInput } from "@/lib/monthly-report-data";
import { PrintButton } from "../../../../brand-board/print-button";

// Print layout of the unsaved preview. Always bannered: it is not a version.
export default async function MonthlyReportPreviewPrintPage({ params, searchParams }: { params: Promise<{ clientId: string }>; searchParams: Promise<{ period?: string }> }) {
  const { clientId } = await params;
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) redirect("/login");
  const now = new Date().toISOString();
  const months = reportPeriods(now, 6);
  const { period: asked } = await searchParams;
  const period = asked && months.includes(asked) ? asked : months[0];
  const loaded = await loadMonthlyReportInput(db, clientId, period, now);
  if (loaded.error === "not_found") notFound();
  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto max-w-4xl px-4 py-6 print:max-w-none print:px-0 print:py-0">
        <div className="mb-4 flex items-center justify-between print:hidden">
          <Link href={`/clients/${clientId}/reports/monthly/preview?period=${period}`} className="text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-primary">&larr; Back to the preview</Link>
          <PrintButton />
        </div>
        <p role="note" className="mb-4 rounded-lg border-2 border-amber-400 bg-amber-50 p-3 text-center text-sm font-semibold uppercase tracking-wider text-amber-900">Preview — not saved, not approved, not for the client</p>
        {loaded.error !== null ? <p role="alert">{loaded.error}</p> : (() => {
          const { defaultEditorial, ...snapshot } = buildMonthlyReport(loaded.data, period, now);
          return <MonthlyReportView report={snapshot} editorial={defaultEditorial} version={0} status="preview" contentHash="not saved" />;
        })()}
      </div>
    </div>
  );
}
