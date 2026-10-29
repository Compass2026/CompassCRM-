import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MonthlyReportView } from "@/components/monthly-report";
import type { Editorial, MonthlyReportSnapshot } from "@/lib/monthly-report";
import { PrintButton } from "../../../../brand-board/print-button";

/**
 * Print-ready monthly report (no app chrome): Cmd/Ctrl+P → "Save as PDF".
 * Rendered from the frozen version only. Team-only by RLS: anyone else
 * reads no version and gets a 404. A version that is not approved prints
 * with a banner saying so.
 */
export default async function MonthlyReportPrintPage({ params }: { params: Promise<{ clientId: string; reportId: string }> }) {
  const { clientId, reportId } = await params;
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) redirect("/login");
  const { data: r } = await db.from("monthly_reports").select("id,version,status,snapshot,editorial,content_hash").eq("id", reportId).eq("client_id", clientId).maybeSingle();
  if (!r) notFound();
  const snapshot = r.snapshot as unknown as MonthlyReportSnapshot;
  const final = r.status === "approved";
  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto max-w-4xl px-4 py-6 print:max-w-none print:px-0 print:py-0">
        <div className="mb-4 flex items-center justify-between print:hidden">
          <Link href={`/clients/${clientId}/reports/monthly/${r.id}`} className="text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-primary">&larr; Back to the report</Link>
          <PrintButton />
        </div>
        {!final && <p role="note" className="mb-4 rounded-lg border-2 border-amber-400 bg-amber-50 p-3 text-center text-sm font-semibold uppercase tracking-wider text-amber-900">
          {snapshot.partial ? "Partial preview — not the month's report" : `Not approved (${r.status.replace("_", " ")}) — not for the client`}
        </p>}
        <MonthlyReportView report={snapshot} editorial={(r.editorial ?? {}) as Editorial} version={r.version} status={r.status} contentHash={r.content_hash} />
      </div>
    </div>
  );
}
