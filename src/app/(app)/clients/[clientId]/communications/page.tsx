import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDateTime, messageTone, pipelineTone } from "@/components/communications/format";
import { contactName, credentialPresence, loadCommsSetup, type CommsSetup } from "@/lib/communications-data";
import { PIPELINE_LABELS, formatPhone, messageStatusLabel } from "@/lib/communications";
import { cn } from "@/lib/utils";

// What still stands between this client and working SMS, in the order it
// has to be done. Nothing here is a secret: credential checks are yes / no.
function warnings(setup: CommsSetup, creds: Awaited<ReturnType<typeof credentialPresence>>, clientId: string) {
  const base = `/clients/${clientId}/communications`;
  const w: { text: string; href: string }[] = [];
  if (!setup.settings?.enabled) w.push({ text: "Communications are off for this client.", href: `${base}/settings` });
  if (!creds.parent) w.push({ text: "Compass's parent Twilio Main key is not in Vault.", href: `${base}/settings` });
  if (!setup.account) w.push({ text: "No Twilio subaccount yet.", href: `${base}/numbers` });
  else {
    if (!creds.subaccountKey) w.push({ text: "The subaccount's own API key is not in Vault (sending and number management will fail).", href: `${base}/numbers` });
    if (!creds.webhookToken) w.push({ text: "The subaccount's auth token is not in Vault: incoming messages will be refused.", href: `${base}/settings` });
  }
  if (setup.account && setup.services.length === 0) w.push({ text: "No Messaging Service yet.", href: `${base}/numbers` });
  if (setup.account && !setup.primary) w.push({ text: "No phone number yet.", href: `${base}/numbers` });
  if (setup.primary && !setup.primary.messaging_service_id) w.push({ text: `${formatPhone(setup.primary.phone_number_e164)} is not in the Messaging Service.`, href: `${base}/numbers` });
  if (setup.primary && !["approved", "restricted", "blocked"].includes(setup.pipeline)) {
    w.push({ text: "The toll-free number is not verified yet: carriers block unverified toll-free SMS.", href: `${base}/compliance` });
  }
  if (setup.registrations.some((r) => r.restriction)) w.push({ text: "A Compass restriction is set on a registration.", href: `${base}/compliance` });
  if (setup.settings?.enabled && !setup.settings.outbound_enabled) w.push({ text: "Sending is turned off (incoming messages are still recorded).", href: `${base}/settings` });
  return w;
}

export default async function CommunicationsOverview({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const supabase = await createClient();
  const setup = await loadCommsSetup(supabase, clientId);
  const [creds, unread, recent] = await Promise.all([
    credentialPresence(supabase, setup.account?.provider_account_sid ?? null),
    supabase.from("communication_conversations").select("id", { count: "exact", head: true }).eq("client_id", clientId).gt("unread_count", 0),
    supabase.from("communication_messages")
      .select("id, direction, body, provider_status, created_at, conversation_id, conversation:communication_conversations!communication_messages_conversation_id_client_id_fkey(contact:contacts!communication_conversations_contact_id_client_id_fkey(first_name, last_name, company, phone_e164))")
      .eq("client_id", clientId).order("created_at", { ascending: false }).limit(10),
  ]);
  const tfv = setup.registrations.find((r) => r.profile_type === "toll_free_verification" && r.communication_number_id === setup.primary?.id)
    ?? setup.registrations.find((r) => r.profile_type === "toll_free_verification");
  const w = warnings(setup, creds, clientId);
  type Recent = { id: string; direction: "inbound" | "outbound"; body: string; provider_status: string; created_at: string; conversation_id: string;
    conversation: { contact: { first_name: string | null; last_name: string | null; company: string | null; phone_e164: string | null } | null } | null };
  const rows = (recent.data ?? []) as unknown as Recent[];

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader><CardTitle className="text-sm text-muted-foreground">Primary number</CardTitle></CardHeader>
          <CardContent>
            <p className="text-lg font-semibold tabular-nums">{setup.primary ? formatPhone(setup.primary.phone_number_e164) : "—"}</p>
            <p className="text-xs text-muted-foreground">{setup.primary ? `${setup.primary.number_type.replace("_", "-")} · ${[setup.primary.sms_enabled && "SMS", setup.primary.voice_enabled && "Voice"].filter(Boolean).join(" + ")}` : "No number yet"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm text-muted-foreground">SMS</CardTitle></CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">{!setup.settings?.enabled ? "Off" : setup.settings.outbound_enabled ? "Sending on" : "Receiving only"}</p>
            <p className="text-xs text-muted-foreground">{setup.services[0]?.friendly_name ?? "No Messaging Service"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm text-muted-foreground">Toll-free verification</CardTitle></CardHeader>
          <CardContent>
            <span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium", pipelineTone(setup.pipeline))}>{PIPELINE_LABELS[setup.pipeline]}</span>
            <p className="mt-1 text-xs text-muted-foreground">{tfv?.provider_status ? `Twilio: ${tfv.provider_status}` : "Not submitted"}{tfv?.last_synced_at ? ` · synced ${fmtDateTime(tfv.last_synced_at)}` : ""}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm text-muted-foreground">Unread conversations</CardTitle></CardHeader>
          <CardContent>
            <p className="text-lg font-semibold tabular-nums">{unread.count ?? 0}</p>
            <Link href={`/clients/${clientId}/communications/inbox?filter=unread`} className="text-xs text-primary hover:underline">Open the inbox</Link>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Configuration</CardTitle></CardHeader>
        <CardContent>
          {w.length === 0 ? (
            <p className="text-sm text-green-800">Everything is in place.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {w.map((x) => (
                <li key={x.text} className="flex items-start gap-2">
                  <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" />
                  <span>{x.text} <Link href={x.href} className="text-primary hover:underline">Fix</Link></span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Recent messages</CardTitle></CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No messages yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {rows.map((m) => {
                const c = m.conversation?.contact ?? null;
                return (
                  <li key={m.id} className="flex items-baseline gap-3 py-2">
                    <span className="w-14 shrink-0 text-xs text-muted-foreground">{m.direction === "inbound" ? "In" : "Out"}</span>
                    <Link href={`/clients/${clientId}/communications/inbox?c=${m.conversation_id}`} className="w-44 shrink-0 truncate font-medium hover:underline">
                      {contactName(c) ?? formatPhone(c?.phone_e164)}
                    </Link>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{m.body}</span>
                    <span className={cn("shrink-0 text-xs", messageTone(m.provider_status))}>{messageStatusLabel(m.provider_status, m.direction)}</span>
                    <span className="w-28 shrink-0 text-right text-xs text-muted-foreground">{fmtDateTime(m.created_at)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
