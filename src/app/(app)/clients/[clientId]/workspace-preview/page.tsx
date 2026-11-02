import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadInquiries, loadInquiry } from "@/lib/inquiries-data";
import { ClientWorkspace } from "@/components/client-workspace/workspace";
import { isUuid } from "@/lib/tasks";

// Team review route. It does not change the client's live /portal routes.
// Explicit authorization here also protects future layout refactors.
export default async function WorkspacePreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ lead?: string }>;
}) {
  const { clientId } = await params;
  const { lead } = await searchParams;
  if (!isUuid(clientId) || (lead && !isUuid(lead))) notFound();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: member } = await supabase
    .from("team_members")
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (!member) notFound();
  const [{ data: client }, list, count] = await Promise.all([
    supabase.from("clients").select("id,name").eq("id", clientId).maybeSingle(),
    loadInquiries(supabase, { kind: "team", clientId }, {}),
    supabase
      .from("inquiries")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId),
  ]);
  if (!client) notFound();
  const selectedId = lead || list.rows[0]?.id;
  const detail = selectedId
    ? await loadInquiry(supabase, { kind: "team", clientId }, selectedId)
    : null;
  if (lead && !detail?.inquiry) notFound();
  // One request-time snapshot is serialized to the client for stable date calculations.
  // eslint-disable-next-line react-hooks/purity -- This is an uncached async server render, not client render time.
  const renderedAt = Date.now();
  const basePath = `/clients/${clientId}/workspace-preview`;
  return (
    <div data-wide-page>
      <ClientWorkspace
        clientId={clientId}
        businessName={client.name}
        rows={list.rows}
        now={renderedAt}
        total={count.count}
        selected={detail?.inquiry ?? null}
        notes={detail?.notes ?? []}
        events={detail?.events ?? []}
        basePath={basePath}
        inquiryBasePath={`/clients/${clientId}/inquiries`}
        error={list.error || count.error?.message}
        preview
      />
    </div>
  );
}
