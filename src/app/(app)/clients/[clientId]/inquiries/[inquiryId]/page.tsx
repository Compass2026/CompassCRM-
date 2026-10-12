import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { InquiryDetail } from "@/components/inquiries/inquiry-views";
import { loadInquiry } from "@/lib/inquiries-data";
import { isUuid } from "@/lib/tasks";
import { BLOCK_REASON_LABELS, JOB_STATUS_LABELS, formatWhen } from "@/lib/inquiries";

// One inquiry in the agency workspace: the full message, contact actions,
// status, notes and history, plus (team only) the website's email outcome
// and the SMS alert jobs, whose delivery status is kept apart from the
// inquiry's own status.
export default async function ClientInquiryPage({ params }: { params: Promise<{ clientId: string; inquiryId: string }> }) {
  const { clientId, inquiryId } = await params;
  if (!isUuid(inquiryId)) notFound();
  const supabase = await createClient();
  const [{ inquiry, notes, events }, { data: client }, { data: extra }, { data: jobs }] = await Promise.all([
    loadInquiry(supabase, { kind: "team", clientId }, inquiryId),
    supabase.from("clients").select("name").eq("id", clientId).maybeSingle(),
    supabase.from("inquiries").select("email_status, submission_id, contact_id").eq("id", inquiryId).eq("client_id", clientId).maybeSingle(),
    supabase.from("notification_jobs").select("id, status, block_reason, provider_status, error_code, sent_at, delivered_at, to_e164")
      .eq("inquiry_id", inquiryId).order("created_at"),
  ]);
  if (!inquiry) notFound();
  const emailText = { accepted: "Website email accepted by Resend", failed: "Website reported its email failed", not_reported: "Website did not report its email" };
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <InquiryDetail inquiry={inquiry} notes={notes} events={events} basePath={`/clients/${clientId}/inquiries`} businessName={client?.name ?? "us"} />
      <section className="space-y-2 rounded-xl border border-dashed p-4 text-sm" aria-label="Delivery (Compass only)">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Delivery (Compass only)</h3>
        <p>{emailText[(extra?.email_status ?? "not_reported") as keyof typeof emailText]}. Submission {extra?.submission_id}.</p>
        {(jobs ?? []).length === 0 ? <p className="text-muted-foreground">No SMS alert recipients were set up when this arrived.</p> : (
          <ul className="space-y-1">
            {(jobs ?? []).map((j) => (
              <li key={j.id} data-alert-job={j.status}>
                SMS alert: {JOB_STATUS_LABELS[j.status] ?? j.status}
                {j.block_reason ? ` — ${BLOCK_REASON_LABELS[j.block_reason] ?? j.block_reason}` : ""}
                {j.provider_status ? ` · Twilio: ${j.provider_status}` : ""}
                {j.error_code ? ` · error ${j.error_code}` : ""}
                {j.delivered_at ? ` · delivered ${formatWhen(j.delivered_at)}` : j.sent_at ? ` · sent ${formatWhen(j.sent_at)}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
