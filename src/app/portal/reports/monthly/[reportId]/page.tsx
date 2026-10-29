import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MonthlyReportView } from "@/components/monthly-report";
import type { Editorial, MonthlyReportSnapshot } from "@/lib/monthly-report";

// A published monthly report, read only through portal_monthly_reports:
// the signed-in contact's own client, approved for the portal and recorded
// as published, without the internal audit section.
export default async function PortalMonthlyReportPage({ params }: { params: Promise<{ reportId: string }> }) {
  const { reportId } = await params;
  const db = await createClient();
  const { data: r } = await db.from("portal_monthly_reports").select("id,version,report,editorial,content_hash").eq("id", reportId).maybeSingle();
  if (!r?.report) notFound();
  return <div className="space-y-4">
    <Link href="/portal/reports" className="text-sm underline print:hidden">&larr; All reports</Link>
    <MonthlyReportView report={r.report as unknown as MonthlyReportSnapshot} editorial={(r.editorial ?? {}) as Editorial} version={r.version ?? 1} status="approved" contentHash={r.content_hash ?? ""} />
  </div>;
}
