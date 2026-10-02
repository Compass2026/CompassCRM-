"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  communicationsFunctionAction,
  createContactAction,
  ensureChecklistAction,
  linkRegistrationAction,
  recordConsentAction,
  saveCommunicationSettingsAction,
  saveRegistrationAction,
  setPrimaryNumberAction,
  setRestrictionAction,
  updateChecklistItemAction,
  updateContactAction,
  updateConversationAction,
  type ActionState,
  type FunctionMode,
} from "@/app/communications-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CONSENT_SOURCES, formatPhone } from "@/lib/communications";
import { cn } from "@/lib/utils";

// The Communications pages' forms. Each posts to a server action that checks
// the caller is on the team; the database and the communications function
// enforce the rules again.

function Result({ state }: { state: ActionState }) {
  if (!state) return null;
  return <span role="status" className={cn("text-xs", state.ok ? "text-green-800" : "text-red-700")}>{state.message}</span>;
}

const label = "block text-xs font-medium text-muted-foreground";
const select = "h-9 w-full rounded-lg border border-input bg-card px-2 text-sm";

// ── Settings ────────────────────────────────────────────────────────────────
export function SettingsForm({ clientId, enabled, outboundEnabled, displayName, notes }: {
  clientId: string; enabled: boolean; outboundEnabled: boolean; displayName: string | null; notes: string | null;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(saveCommunicationSettingsAction.bind(null, clientId), null);
  return (
    <form action={action} className="space-y-3 text-sm">
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" name="enabled" defaultChecked={enabled} className="size-4" />
        Communications enabled for this client
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" name="outbound_enabled" defaultChecked={outboundEnabled} className="size-4" />
        Teammates may send SMS (consent is still checked on every message)
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="display_name">Display name</label>
          <Input id="display_name" name="display_name" defaultValue={displayName ?? ""} placeholder="e.g. the business's short name" />
        </div>
      </div>
      <div>
        <label className={label} htmlFor="notes">Notes</label>
        <Textarea id="notes" name="notes" defaultValue={notes ?? ""} rows={3} />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>Save</Button>
        <Result state={state} />
      </div>
    </form>
  );
}

// ── Contacts and consent ────────────────────────────────────────────────────
export function ContactForm({ clientId, contact }: {
  clientId: string;
  contact?: { id: string; first_name: string | null; last_name: string | null; company: string | null; email: string | null; phone_e164: string | null };
}) {
  const bound = contact ? updateContactAction.bind(null, clientId, contact.id) : createContactAction.bind(null, clientId);
  const [state, action, pending] = useActionState<ActionState, FormData>(bound, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => { if (state?.ok && !contact) ref.current?.reset(); }, [state, contact]);
  return (
    <form ref={ref} action={action} className="grid gap-2 text-sm sm:grid-cols-2">
      <div><label className={label}>First name</label><Input name="first_name" defaultValue={contact?.first_name ?? ""} /></div>
      <div><label className={label}>Last name</label><Input name="last_name" defaultValue={contact?.last_name ?? ""} /></div>
      <div><label className={label}>Company</label><Input name="company" defaultValue={contact?.company ?? ""} /></div>
      <div><label className={label}>Email</label><Input name="email" type="email" defaultValue={contact?.email ?? ""} /></div>
      {contact ? (
        <p className="text-xs text-muted-foreground sm:col-span-2">Mobile: {formatPhone(contact.phone_e164) || "—"} (a number with messages on record cannot change)</p>
      ) : (
        <div><label className={label}>Mobile number</label><Input name="phone" inputMode="tel" placeholder="(573) 555-0100" /></div>
      )}
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" size="sm" disabled={pending}>{contact ? "Save contact" : "Add contact"}</Button>
        <Result state={state} />
      </div>
    </form>
  );
}

export function ConsentForm({ clientId, phone, contactId, current }: {
  clientId: string; phone: string; contactId: string | null; current: "granted" | "revoked" | "opted_out" | null;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(recordConsentAction.bind(null, clientId), null);
  if (current === "opted_out") {
    return <p className="text-xs text-amber-900">This number texted STOP. Only the recipient can opt back in, by texting START to the business number.</p>;
  }
  const form = (
      <form action={action} className="space-y-2 text-sm">
        <input type="hidden" name="phone" value={phone} />
        <input type="hidden" name="contact_id" value={contactId ?? ""} />
        <input type="hidden" name="status" value="granted" />
        <div>
          <label className={label}>How did they agree?</label>
          <select name="source" className={select} defaultValue="web_form">
            {CONSENT_SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        <div><label className={label}>Evidence (what they agreed to, where it is recorded)</label><Textarea name="evidence" rows={2} required /></div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div><label className={label}>Opt-in page URL</label><Input name="source_url" placeholder="https://…" /></div>
          <div><label className={label}>Disclosure version</label><Input name="disclosure_version" placeholder="e.g. 2026-10-01" /></div>
        </div>
        <div><label className={label}>When (defaults to now)</label><Input name="consented_at" type="datetime-local" /></div>
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={pending}>{current === "granted" ? "Update consent" : "Record consent"}</Button>
          <Result state={state} />
        </div>
      </form>
  );
  // Consent already on record: the forms stay folded until needed.
  if (current === "granted") {
    return (
      <details className="space-y-3">
        <summary className="cursor-pointer text-xs text-primary">Update or revoke consent</summary>
        <div className="space-y-3 pt-2">
          {form}
          <RevokeConsent clientId={clientId} phone={phone} contactId={contactId} />
        </div>
      </details>
    );
  }
  return form;
}

function RevokeConsent({ clientId, phone, contactId }: { clientId: string; phone: string; contactId: string | null }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(recordConsentAction.bind(null, clientId), null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2 border-t pt-3 text-sm">
      <input type="hidden" name="phone" value={phone} />
      <input type="hidden" name="contact_id" value={contactId ?? ""} />
      <input type="hidden" name="status" value="revoked" />
      <div className="min-w-48 flex-1"><label className={label}>Revoke: why</label><Input name="evidence" placeholder="e.g. asked by phone to stop texting" /></div>
      <Button type="submit" size="sm" variant="destructive" disabled={pending}>Revoke consent</Button>
      <Result state={state} />
    </form>
  );
}

// Marks the open thread read once it is on screen.
export function MarkRead({ clientId, conversationId, unread }: { clientId: string; conversationId: string; unread: number }) {
  const router = useRouter();
  useEffect(() => {
    if (unread > 0) void updateConversationAction(clientId, conversationId, { mark_read: true }).then(() => router.refresh());
  }, [clientId, conversationId, unread, router]);
  return null;
}

export function ConversationControls({ clientId, conversationId, status, assignee, team }: {
  clientId: string; conversationId: string; status: "open" | "closed"; assignee: string | null; team: { id: string; name: string }[];
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<ActionState>(null);
  const router = useRouter();
  const run = (patch: Parameters<typeof updateConversationAction>[2]) =>
    start(async () => { setMsg(await updateConversationAction(clientId, conversationId, patch)); router.refresh(); });
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <select aria-label="Assigned to" className="h-8 rounded-lg border border-input bg-card px-2 text-sm" disabled={pending}
        defaultValue={assignee ?? ""} onChange={(e) => run({ assigned_user_id: e.target.value || null })}>
        <option value="">Unassigned</option>
        {team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => run({ status: status === "open" ? "closed" : "open" })}>
        {status === "open" ? "Close" : "Reopen"}
      </Button>
      {msg && !msg.ok && <Result state={msg} />}
    </div>
  );
}

// Reloads the inbox every 10 s while the tab is visible.
export function InboxRefresher({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}

// ── Numbers and the Twilio account ──────────────────────────────────────────
// One button that asks the communications function for one action.
export function FunctionButton({ clientId, mode, payload, label: text, variant = "outline", confirm, disabled }: {
  clientId: string; mode: FunctionMode; payload?: Record<string, string>; label: string;
  variant?: "default" | "outline" | "accent"; confirm?: string; disabled?: boolean;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<ActionState>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" variant={variant} disabled={pending || disabled} onClick={() => {
        if (confirm && !window.confirm(confirm)) return;
        start(async () => { const r = await communicationsFunctionAction(clientId, mode, payload); setMsg({ ok: r.ok, message: r.message }); });
      }}>{pending ? "Working…" : text}</Button>
      <Result state={msg} />
    </span>
  );
}

// Create (or link) the client's subaccount: the admin types the client's name.
export function SubaccountForm({ clientId, clientName }: { clientId: string; clientName: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<ActionState>(null);
  const [confirm, setConfirm] = useState("");
  const [sid, setSid] = useState("");
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-64 flex-1">
          <label className={label}>Create a new subaccount — type “{clientName}” to confirm</label>
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <Button size="sm" disabled={pending || confirm !== clientName} onClick={() => start(async () => {
          const r = await communicationsFunctionAction(clientId, "create_subaccount", { confirm });
          setMsg({ ok: r.ok, message: r.message });
        })}>Create subaccount</Button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-64 flex-1">
          <label className={label}>…or link one made in the Twilio Console (its AC… SID)</label>
          <Input value={sid} onChange={(e) => setSid(e.target.value.trim())} placeholder="AC…" />
        </div>
        <Button size="sm" variant="outline" disabled={pending || !/^AC[0-9a-f]{32}$/.test(sid)} onClick={() => start(async () => {
          const r = await communicationsFunctionAction(clientId, "link_subaccount", { account_sid: sid });
          setMsg({ ok: r.ok, message: r.message });
        })}>Link subaccount</Button>
      </div>
      <Result state={msg} />
    </div>
  );
}

type Available = { phone_number: string; friendly_name: string | null; sms: boolean; voice: boolean; mms: boolean; preferred_prefix: boolean };

// Search, then an explicit purchase of ONE number the admin picked and typed
// again. Nothing is bought by searching.
export function NumberSearch({ clientId, canPurchase }: { clientId: string; canPurchase: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<ActionState>(null);
  const [areaCode, setAreaCode] = useState("800");
  const [results, setResults] = useState<Available[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className={label}>Preferred toll-free prefix</label>
          <select className={select} value={areaCode} onChange={(e) => setAreaCode(e.target.value)}>
            {["800", "888", "877", "866", "855", "844", "833"].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => {
          const r = await communicationsFunctionAction(clientId, "search_numbers", { area_code: areaCode });
          setMsg({ ok: r.ok, message: r.message });
          setResults(r.ok ? ((r.data?.numbers as Available[]) ?? []) : null);
          setPicked(null); setConfirm("");
        })}>Search available numbers</Button>
      </div>
      <Result state={msg} />
      {results && results.length === 0 && <p className="text-xs text-muted-foreground">No SMS + voice toll-free numbers available right now.</p>}
      {results && results.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {results.map((n) => (
            <li key={n.phone_number} className="flex items-center gap-3 px-3 py-2">
              {canPurchase && <input type="radio" name="pick" className="size-4" checked={picked === n.phone_number} onChange={() => { setPicked(n.phone_number); setConfirm(""); }} />}
              <span className="font-medium tabular-nums">{formatPhone(n.phone_number)}</span>
              <span className="text-xs text-muted-foreground">{[n.sms && "SMS", n.voice && "Voice", n.mms && "MMS"].filter(Boolean).join(" · ")}</span>
              {n.preferred_prefix && <span className="text-xs text-green-800">preferred prefix</span>}
            </li>
          ))}
        </ul>
      )}
      {canPurchase && picked && (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs text-amber-900">
            Buying a number charges Compass&apos;s Twilio account monthly. Type <strong className="tabular-nums">{picked}</strong> to confirm.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <Input className="max-w-56" value={confirm} onChange={(e) => setConfirm(e.target.value.trim())} placeholder={picked} />
            <Button size="sm" variant="accent" disabled={pending || confirm !== picked} onClick={() => start(async () => {
              const r = await communicationsFunctionAction(clientId, "purchase_number", { phone_number: picked, confirm });
              setMsg({ ok: r.ok, message: r.ok ? `${r.message} ${formatPhone(picked)} is in the client's subaccount.` : r.message });
              if (r.ok) { setResults(null); setPicked(null); }
            })}>Purchase this number</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function LinkNumberForm({ clientId }: { clientId: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<ActionState>(null);
  const [sid, setSid] = useState("");
  return (
    <div className="flex flex-wrap items-end gap-2 text-sm">
      <div className="min-w-64 flex-1">
        <label className={label}>Link a number already in the subaccount (its PN… SID)</label>
        <Input value={sid} onChange={(e) => setSid(e.target.value.trim())} placeholder="PN…" />
      </div>
      <Button size="sm" variant="outline" disabled={pending || !/^PN[0-9a-f]{32}$/.test(sid)} onClick={() => start(async () => {
        const r = await communicationsFunctionAction(clientId, "link_number", { number_sid: sid });
        setMsg({ ok: r.ok, message: r.message });
      })}>Link number</Button>
      <Result state={msg} />
    </div>
  );
}

export function PrimaryButton({ clientId, numberId }: { clientId: string; numberId: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<ActionState>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="xs" variant="outline" disabled={pending} onClick={() => start(async () => setMsg(await setPrimaryNumberAction(clientId, numberId)))}>Make primary</Button>
      {msg && !msg.ok && <Result state={msg} />}
    </span>
  );
}

// ── Compliance ──────────────────────────────────────────────────────────────
export type RegistrationValues = Record<string, string | string[] | null>;

const v = (x: RegistrationValues | null, k: string) => {
  const val = x?.[k];
  return Array.isArray(val) ? val.join("\n") : (val ?? "");
};

export function RegistrationForm({ clientId, profileId, profileType, values, numbers }: {
  clientId: string; profileId: string | null; profileType: "secondary_customer_profile" | "toll_free_verification";
  values: RegistrationValues | null; numbers: { id: string; label: string }[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(saveRegistrationAction.bind(null, clientId, profileId, profileType), null);
  const tfv = profileType === "toll_free_verification";
  const field = (name: string, text: string, opts: { placeholder?: string; type?: string } = {}) => (
    <div><label className={label} htmlFor={`${profileType}-${name}`}>{text}</label>
      <Input id={`${profileType}-${name}`} name={name} type={opts.type} defaultValue={v(values, name)} placeholder={opts.placeholder} /></div>
  );
  return (
    <form action={action} className="space-y-3 text-sm">
      <div className="grid gap-2 sm:grid-cols-2">
        {field("legal_business_name", "Legal business name")}
        {field("doing_business_as", "Doing business as")}
        {field("website_url", "Website", { placeholder: "https://…" })}
        {field("notification_email", "Notification email (Twilio status mail)", { type: "email" })}
        {field("address_street", "Street")}
        {field("address_city", "City")}
        {field("address_region", "State")}
        {field("address_postal_code", "ZIP")}
        {field("business_contact_name", "Business contact")}
        {field("business_contact_email", "Business contact email", { type: "email" })}
        {field("business_contact_phone", "Business contact phone")}
      </div>
      {tfv && (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className={label}>Toll-free number</label>
              <select name="communication_number_id" className={select} defaultValue={v(values, "communication_number_id")}>
                <option value="">— not purchased yet —</option>
                {numbers.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
              </select>
            </div>
            {field("message_volume", "Monthly message volume", { placeholder: "1,000" })}
            <div>
              <label className={label}>Opt-in type</label>
              <select name="opt_in_type" className={select} defaultValue={v(values, "opt_in_type")}>
                <option value="">—</option>
                {["WEB_FORM", "VERBAL", "PAPER_FORM", "VIA_TEXT", "MOBILE_QR_CODE", "IMPORT"].map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            {field("opt_in_url", "Opt-in page URL", { placeholder: "https://…" })}
            {field("privacy_url", "Privacy Policy URL", { placeholder: "https://…" })}
            {field("terms_url", "Terms URL", { placeholder: "https://…" })}
          </div>
          <div><label className={label}>Use case categories (one per line, Twilio&apos;s names)</label>
            <Textarea name="use_case_categories" rows={2} defaultValue={v(values, "use_case_categories")} placeholder="CUSTOMER_CARE" /></div>
          <div><label className={label}>Use case summary</label><Textarea name="use_case_summary" rows={3} defaultValue={v(values, "use_case_summary")} /></div>
          <div><label className={label}>Sample messages (one per line)</label><Textarea name="sample_messages" rows={4} defaultValue={v(values, "sample_messages")} /></div>
          <div><label className={label}>Opt-in screenshot URLs (one per line)</label><Textarea name="opt_in_image_urls" rows={2} defaultValue={v(values, "opt_in_image_urls")} /></div>
        </>
      )}
      {!tfv && (
        <div className="grid gap-2 sm:grid-cols-2">
          {field("privacy_url", "Privacy Policy URL", { placeholder: "https://…" })}
          {field("terms_url", "Terms URL", { placeholder: "https://…" })}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Compass never stores the EIN. Enter it from the business&apos;s IRS record in the Twilio Console when you submit.
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>{profileId ? "Save details" : "Start this registration"}</Button>
        <Result state={state} />
      </div>
    </form>
  );
}

export function LinkRegistrationForm({ clientId, profileId, sid, prefix }: { clientId: string; profileId: string; sid: string | null; prefix: "BU" | "HH" }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(linkRegistrationAction.bind(null, clientId, profileId), null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2 text-sm">
      <div className="min-w-64 flex-1">
        <label className={label}>Twilio SID ({prefix}…) of the submitted registration</label>
        <Input name="provider_profile_sid" defaultValue={sid ?? ""} placeholder={`${prefix}…`} />
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>Link</Button>
      <Result state={state} />
    </form>
  );
}

export function RestrictionForm({ clientId, profileId, restriction, reason }: { clientId: string; profileId: string; restriction: string | null; reason: string | null }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(setRestrictionAction.bind(null, clientId, profileId), null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2 text-sm">
      <div>
        <label className={label}>Compass restriction</label>
        <select name="restriction" className={select} defaultValue={restriction ?? ""}>
          <option value="">None</option>
          <option value="restricted">Restricted</option>
          <option value="blocked">Blocked</option>
        </select>
      </div>
      <div className="min-w-48 flex-1"><label className={label}>Reason</label><Input name="restriction_reason" defaultValue={reason ?? ""} /></div>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>Save</Button>
      <Result state={state} />
    </form>
  );
}

export function EnsureChecklistButton({ clientId, profileId }: { clientId: string; profileId: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<ActionState>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => setMsg(await ensureChecklistAction(clientId, profileId)))}>Add the standard checklist</Button>
      <Result state={msg} />
    </span>
  );
}

export function ChecklistItemForm({ clientId, item }: { clientId: string; item: { id: string; label: string; status: string; evidence: string | null } }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateChecklistItemAction.bind(null, clientId, item.id), null);
  return (
    <form action={action} className="grid gap-2 py-2 text-sm sm:grid-cols-[1fr_9rem_1fr_auto] sm:items-center">
      <span className={cn(item.status === "done" && "text-muted-foreground line-through decoration-green-700/50")}>{item.label}</span>
      <select name="status" aria-label="Status" className={select} defaultValue={item.status}>
        <option value="open">Open</option>
        <option value="done">Done</option>
        <option value="not_applicable">Not applicable</option>
      </select>
      <Input name="evidence" aria-label="Evidence" defaultValue={item.evidence ?? ""} placeholder="Evidence (URL, where to look)" />
      <span className="flex items-center gap-2">
        <Button type="submit" size="xs" variant="outline" disabled={pending}>Save</Button>
        <Result state={state} />
      </span>
    </form>
  );
}
