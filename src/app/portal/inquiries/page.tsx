import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadInquiries, loadInquiry } from "@/lib/inquiries-data";
import { ClientWorkspace } from "@/components/client-workspace/workspace";
import { isUuid } from "@/lib/tasks";
export default async function PortalInquiriesPage({
  searchParams,
}: {
  searchParams: Promise<{ lead?: string }>;
}) {
  const { lead } = await searchParams;
  if (lead && !isUuid(lead)) notFound();
  const supabase = await createClient();
  const [{ data: on }, { data: client }] = await Promise.all([
    supabase.from("portal_crm_lite").select("client_id").maybeSingle(),
    supabase.from("portal_client").select("name").maybeSingle(),
  ]);
  if (!on?.client_id || !client) notFound();
  const list = await loadInquiries(supabase, { kind: "portal" }, {});
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
