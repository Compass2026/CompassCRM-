import { createClient } from "@/lib/supabase/server";
import { CommsNav } from "@/components/communications/comms-nav";
import { pipelineTone } from "@/components/communications/format";
import { loadCommsSetup } from "@/lib/communications-data";
import { PIPELINE_LABELS } from "@/lib/communications";
import { cn } from "@/lib/utils";

// Client › Communications (0063): SMS through the client's own Twilio
// subaccount. Overview / Inbox / Numbers / Compliance / Settings.
export default async function CommunicationsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await createClient();
  const [setup, unread] = await Promise.all([
    loadCommsSetup(supabase, clientId),
    supabase.from("communication_conversations").select("id", { count: "exact", head: true }).eq("client_id", clientId).gt("unread_count", 0),
  ]);
  const on = setup.settings?.enabled ?? false;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-navy-900">Communications</h2>
          <span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium", pipelineTone(setup.pipeline))}>
            SMS: {PIPELINE_LABELS[setup.pipeline]}
          </span>
          {!on && <span className="rounded-full border border-zinc-200 bg-zinc-100 px-2.5 py-0.5 text-xs text-zinc-600">Off for this client</span>}
        </div>
        <CommsNav clientId={clientId} unread={unread.count ?? 0} />
      </div>
      {children}
    </div>
  );
}
