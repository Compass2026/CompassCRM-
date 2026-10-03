import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Composer } from "@/components/communications/composer";
import {
  ConsentForm,
  ContactForm,
  ConversationControls,
  InboxRefresher,
  MarkRead,
} from "@/components/communications/forms";
import { fmtDateTime, messageTone, tone } from "@/components/communications/format";
import {
  contactName,
  loadCommsSetup,
  loadConsent,
  loadConversations,
  loadMessages,
} from "@/lib/communications-data";
import { CONSENT_LABELS, canSendTo, formatPhone, messageStatusLabel } from "@/lib/communications";
import { listTeamMembers } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import { chip } from "@/lib/nav-styles";
import { cn } from "@/lib/utils";

const FILTERS = ["open", "unread", "closed", "all"] as const;
type Filter = typeof FILTERS[number];

// Shared inbox: conversations | the thread | the contact and their consent.
export default async function InboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ c?: string; filter?: string; new?: string }>;
}) {
  const { clientId } = await params;
  const sp = await searchParams;
  const filter: Filter = (FILTERS as readonly string[]).includes(sp.filter ?? "") ? (sp.filter as Filter) : "open";
  const supabase = await createClient();
  const [setup, conversations, team] = await Promise.all([
    loadCommsSetup(supabase, clientId),
    loadConversations(supabase, clientId, filter),
    listTeamMembers(supabase),
  ]);
  const base = `/clients/${clientId}/communications/inbox`;
  const selectedId = sp.c && isUuid(sp.c) ? sp.c : null;
  let selected = selectedId ? conversations.find((c) => c.id === selectedId) ?? null : null;
  if (selectedId && !selected) {
    // The thread may be outside the current filter.
    selected = (await loadConversations(supabase, clientId, "all")).find((c) => c.id === selectedId) ?? null;
  }
  const composingNew = sp.new === "1" && !selected;
  const { data: contactsData } = composingNew
    ? await supabase.from("contacts").select("id, first_name, last_name, company, phone_e164").eq("client_id", clientId).not("phone_e164", "is", null).order("first_name").limit(500)
    : { data: [] };

  const contact = selected?.contact ?? null;
  const [messages, consent] = await Promise.all([
    selected ? loadMessages(supabase, clientId, selected.id) : Promise.resolve([]),
    loadConsent(supabase, clientId, contact?.phone_e164 ?? null),
  ]);
  const careConsent = consent.consents.find((c) => c.consent_type === "sms_customer_care") ?? null;
  const optedOut = consent.consents.some((c) => c.status === "opted_out");
  const currentConsent = optedOut ? "opted_out" : careConsent?.status ?? null;
  const gate = canSendTo(careConsent?.status ?? null, optedOut);
  const sendingOff = !setup.settings?.enabled ? "Communications are off for this client (Settings)."
    : !setup.settings.outbound_enabled ? "Sending is turned off for this client (Settings). Incoming messages are still recorded." : null;
  const teamNames = new Map(team.map((m) => [m.id, m.name]));

  return (
    <div className="space-y-3">
      <InboxRefresher />
      {selected && <MarkRead clientId={clientId} conversationId={selected.id} unread={selected.unread_count} />}
      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)_18rem]">
        {/* Conversations */}
        <Card className="min-h-[28rem]">
          <CardHeader className="space-y-2">
            <div className="flex items-center justify-between">
              <CardTitle>Conversations</CardTitle>
              <Link href={`${base}?new=1`} className="text-xs text-primary hover:underline">New message</Link>
            </div>
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <Link key={f} href={`${base}?filter=${f}`} className={cn(chip(filter === f), "h-7 px-2.5 text-xs capitalize")}>{f}</Link>
              ))}
            </div>
          </CardHeader>
          <CardContent className="px-2">
            {conversations.length === 0 ? (
              <p className="px-2 text-sm text-muted-foreground">No conversations.</p>
            ) : (
              <ul className="space-y-0.5">
                {conversations.map((c) => (
                  <li key={c.id}>
                    <Link href={`${base}?c=${c.id}&filter=${filter}`} aria-current={selected?.id === c.id ? "true" : undefined}
                      className={cn("block rounded-lg px-2 py-2 text-sm hover:bg-royal-50", selected?.id === c.id && "bg-royal-50 ring-1 ring-royal-100")}>
                      <span className="flex items-baseline justify-between gap-2">
                        <span className={cn("truncate", c.unread_count > 0 ? "font-semibold" : "font-medium")}>
                          {contactName(c.contact) ?? formatPhone(c.contact?.phone_e164)}
                        </span>
                        {c.unread_count > 0 && <span className="rounded-full bg-orange-500 px-1.5 text-xs font-semibold text-white">{c.unread_count}</span>}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {c.last_direction === "outbound" ? "You: " : ""}{c.last_message_preview ?? ""}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">{fmtDateTime(c.last_message_at)}{c.status === "closed" ? " · closed" : ""}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Thread */}
        <Card className="min-h-[28rem]">
          {selected ? (
            <>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle>{contactName(contact) ?? formatPhone(contact?.phone_e164)}</CardTitle>
                <ConversationControls clientId={clientId} conversationId={selected.id} status={selected.status} assignee={selected.assigned_user_id} team={team} />
              </CardHeader>
              <CardContent className="space-y-4">
                <ol className="max-h-[32rem] space-y-2 overflow-y-auto pr-1">
                  {messages.map((m) => (
                    <li key={m.id} className={cn("flex", m.direction === "outbound" ? "justify-end" : "justify-start")}>
                      <div className={cn("max-w-[80%] rounded-2xl px-3 py-2 text-sm",
                        m.direction === "outbound" ? "bg-royal-600 text-white" : "bg-muted text-foreground")}>
                        <p className="whitespace-pre-wrap break-words">{m.body}</p>
                        <p className={cn("mt-1 text-[11px]", m.direction === "outbound" ? "text-white/75" : "text-muted-foreground")}>
                          {fmtDateTime(m.created_at)}
                          {m.direction === "outbound" && m.sent_by ? ` · ${teamNames.get(m.sent_by) ?? "teammate"}` : ""}
                          {" · "}
                          <span className={m.direction === "outbound" ? "" : messageTone(m.provider_status)}>{messageStatusLabel(m.provider_status, m.direction)}</span>
                          {m.error_code ? ` (${m.error_code})` : ""}
                          {m.opt_out_type ? ` · ${m.opt_out_type}` : ""}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
                <Composer clientId={clientId} conversationId={selected.id} blockedReason={sendingOff ?? (gate.ok ? null : gate.reason)} />
              </CardContent>
            </>
          ) : composingNew ? (
            <NewMessage clientId={clientId} contacts={(contactsData ?? []) as NewContact[]} sendingOff={sendingOff} />
          ) : (
            <CardContent className="grid h-full place-items-center py-16 text-sm text-muted-foreground">Pick a conversation.</CardContent>
          )}
        </Card>

        {/* Contact and consent */}
        <Card className="min-h-[28rem]">
          <CardHeader><CardTitle>Contact</CardTitle></CardHeader>
          <CardContent className="space-y-4 text-sm">
            {contact ? (
              <>
                <div className="space-y-0.5">
                  <p className="font-medium">{contactName(contact) ?? "Unnamed contact"}</p>
                  <p className="tabular-nums text-muted-foreground">{formatPhone(contact.phone_e164)}</p>
                  {contact.company && <p className="text-muted-foreground">{contact.company}</p>}
                  {contact.email && <p className="text-muted-foreground">{contact.email}</p>}
                </div>
                <details>
                  <summary className="cursor-pointer text-xs text-primary">Edit contact</summary>
                  <div className="pt-2"><ContactForm clientId={clientId} contact={contact} /></div>
                </details>
                <div className="space-y-2 border-t pt-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">SMS consent</p>
                  <span className={cn("inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium",
                    currentConsent === "granted" ? tone.good : currentConsent === "opted_out" ? tone.bad : currentConsent === "revoked" ? tone.warn : tone.none)}>
                    {CONSENT_LABELS[currentConsent ?? "none"]}
                  </span>
                  {careConsent?.status === "granted" && (
                    <p className="text-xs text-muted-foreground">
                      {careConsent.source.replace("_", " ")} · {fmtDateTime(careConsent.consented_at)}
                      {careConsent.evidence ? ` · ${careConsent.evidence}` : ""}
                    </p>
                  )}
                  {contact.phone_e164 && <ConsentForm clientId={clientId} phone={contact.phone_e164} contactId={contact.id} current={currentConsent} />}
                </div>
                {consent.events.length > 0 && (
                  <div className="space-y-1 border-t pt-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Consent history</p>
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {consent.events.map((e) => (
                        <li key={e.id}>{fmtDateTime(e.created_at)} · {e.from_status ?? "none"} → {e.to_status} ({e.actor_kind}, {e.source.replace("_", " ")})</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <div className="space-y-2">
                <p className="text-muted-foreground">Add a contact the client may text. Consent is recorded separately: a phone number alone is not consent.</p>
                <ContactForm clientId={clientId} />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

type NewContact = { id: string; first_name: string | null; last_name: string | null; company: string | null; phone_e164: string };

// A first message to a contact with no thread yet: pick, then compose. The
// composer refuses without consent, as everywhere.
function NewMessage({ clientId, contacts, sendingOff }: { clientId: string; contacts: NewContact[]; sendingOff: string | null }) {
  return (
    <>
      <CardHeader><CardTitle>New message</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {contacts.length === 0 ? (
          <p className="text-muted-foreground">No contacts with a mobile number yet. Add one in the right-hand column.</p>
        ) : (
          <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border">
            {contacts.map((c) => (
              <li key={c.id} className="space-y-2 px-3 py-2">
                <details>
                  <summary className="cursor-pointer">
                    <span className="font-medium">{contactName(c) ?? "Unnamed"}</span>{" "}
                    <span className="tabular-nums text-muted-foreground">{formatPhone(c.phone_e164)}</span>
                  </summary>
                  <div className="pt-2">
                    <Composer clientId={clientId} contactId={c.id} blockedReason={sendingOff}
                      openThreadBase={`/clients/${clientId}/communications/inbox`} />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">Sending checks this person&apos;s SMS consent first; without it the message is refused.</p>
      </CardContent>
    </>
  );
}
