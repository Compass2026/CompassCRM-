import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadInquiries, loadInquiry } from "@/lib/inquiries-data";
import { ClientWorkspace } from "@/components/client-workspace/workspace";
import { InquiryList } from "@/components/inquiries/inquiry-views";
import { isInquiryStatus } from "@/lib/inquiries";
import { isUuid } from "@/lib/tasks";
export default async function PortalInquiriesPage({
  searchParams,
}: {
  searchParams: Promise<{ lead?: string; q?: string; status?: string }>;
}) {
  const { lead, q = "", status } = await searchParams;
  if (lead && !isUuid(lead)) notFound();
  const supabase = await createClient();
  const [{ data: on }, { data: client }] = await Promise.all([
    supabase.from("portal_crm_lite").select("*").maybeSingle(),
    supabase.from("portal_client").select("name").maybeSingle(),
  ]);
  if (!on?.client_id || !client) notFound();
  const enhanced = "workspace_enabled" in on && on.workspace_enabled === true;
  const list = await loadInquiries(
    supabase,
    { kind: "portal" },
    enhanced ? {} : { q, status },
  );
  if (!enhanced)
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <div>
          <h1 className="page-title kicker mb-1">Inquiries</h1>
          <p className="text-sm text-muted-foreground">
            Website inquiries, newest first. Mark each one contacted, then
            closed.
          </p>
        </div>
        <InquiryList
          basePath="/portal/inquiries"
          rows={list.rows}
          counts={list.counts}
          q={q}
          status={isInquiryStatus(status) ? status : null}
        />
      </div>
    );
  const selectedId = lead || list.rows[0]?.id;
  const detail = selectedId
    ? await loadInquiry(supabase, { kind: "portal" }, selectedId)
    : null;
  if (lead && !detail?.inquiry) notFound();
  // eslint-disable-next-line react-hooks/purity -- Request-time server snapshot.
  const now = Date.now();
  return (
    <ClientWorkspace
      clientId={on.client_id}
      businessName={client.name || "Your business"}
      rows={list.rows}
      now={now}
      total={list.counts.all}
      selected={detail?.inquiry ?? null}
      notes={detail?.notes ?? []}
      events={detail?.events ?? []}
      basePath="/portal/inquiries"
      inquiryBasePath="/portal/inquiries"
      error={list.error}
    />
  );
}
