import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { InquiryList } from "@/components/inquiries/inquiry-views";
import { loadInquiries } from "@/lib/inquiries-data";
import { isInquiryStatus } from "@/lib/inquiries";

// Client › Inquiries (CRM Lite): the client's website inquiries, newest first.
export default async function ClientInquiriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const { clientId } = await params;
  const { q = "", status } = await searchParams;
  const supabase = await createClient();
  const [{ rows, counts }, { data: settings }] = await Promise.all([
    loadInquiries(supabase, { kind: "team", clientId }, { q, status }),
    supabase.from("crm_lite_settings").select("enabled, portal_enabled, sms_alerts_enabled").eq("client_id", clientId).maybeSingle(),
  ]);
  const basePath = `/clients/${clientId}/inquiries`;
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-navy-900">Inquiries</h2>
          <span className="rounded-full border px-2.5 py-0.5 text-xs">{settings?.enabled ? "CRM Lite on" : "CRM Lite off"}</span>
          {settings?.portal_enabled && <span className="rounded-full border px-2.5 py-0.5 text-xs">Client portal access on</span>}
          <span className="rounded-full border px-2.5 py-0.5 text-xs">SMS alerts {settings?.sms_alerts_enabled ? "on" : "off"}</span>
        </div>
        <Link href={`${basePath}/settings`} className="text-sm font-medium text-royal-700 hover:underline">Setup &amp; alerts</Link>
      </div>
      {!settings?.enabled && rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
          CRM Lite is off for this client. Turn it on and connect the website form under{" "}
          <Link href={`${basePath}/settings`} className="underline">Setup &amp; alerts</Link>.
        </p>
      ) : (
        <InquiryList basePath={basePath} rows={rows} counts={counts} q={q} status={isInquiryStatus(status) ? status : null} />
      )}
    </div>
  );
}
