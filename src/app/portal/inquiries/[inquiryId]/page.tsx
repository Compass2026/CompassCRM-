import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { InquiryDetail } from "@/components/inquiries/inquiry-views";
import { loadInquiry } from "@/lib/inquiries-data";
import { isUuid } from "@/lib/tasks";

// One of the client's own inquiries. Another client's id (or a made-up one)
// finds nothing in the portal views and is a 404. The link in an SMS alert
// lands here, behind the portal sign-in.
export default async function PortalInquiryPage({ params }: { params: Promise<{ inquiryId: string }> }) {
  const { inquiryId } = await params;
  if (!isUuid(inquiryId)) notFound();
  const supabase = await createClient();
  const [{ inquiry, notes, events }, { data: client }] = await Promise.all([
    loadInquiry(supabase, { kind: "portal" }, inquiryId),
    supabase.from("portal_client").select("name").maybeSingle(),
  ]);
  if (!inquiry) notFound();
  return (
    <div className="mx-auto max-w-3xl">
      <InquiryDetail inquiry={inquiry} notes={notes} events={events} basePath="/portal/inquiries" businessName={client?.name ?? "us"} />
    </div>
  );
}
