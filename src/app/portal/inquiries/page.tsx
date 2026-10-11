import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { InquiryList } from "@/components/inquiries/inquiry-views";
import { loadInquiries } from "@/lib/inquiries-data";
import { isInquiryStatus } from "@/lib/inquiries";

// Portal › Inquiries (CRM Lite): the client's own website inquiries, through
// the portal_* views (filtered to this sign-in's client, only while Compass
// has turned portal access on).
export default async function PortalInquiriesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const { q = "", status } = await searchParams;
  const supabase = await createClient();
  const { data: on } = await supabase.from("portal_crm_lite").select("client_id").maybeSingle();
  if (!on) notFound();
  const { rows, counts } = await loadInquiries(supabase, { kind: "portal" }, { q, status });
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="page-title kicker mb-1">Inquiries</h1>
        <p className="text-sm text-muted-foreground">Website inquiries, newest first. Mark each one contacted, then closed.</p>
      </div>
      <InquiryList basePath="/portal/inquiries" rows={rows} counts={counts} q={q} status={isInquiryStatus(status) ? status : null} />
    </div>
  );
}
