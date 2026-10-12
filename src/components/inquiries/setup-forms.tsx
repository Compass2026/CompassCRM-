"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  addRecipientAction,
  chooseSenderAction,
  confirmDeliveryTestAction,
  createSourceAction,
  issueIntakeTokenAction,
  recordAlertConsentAction,
  saveCrmLiteSettingsAction,
  saveSenderAction,
  sendDeliveryTestAction,
  setRecipientEnabledAction,
  setSmsAlertsAction,
  setSourceEnabledAction,
  type CrmLiteState,
} from "@/app/crm-lite-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CopyTextButton } from "@/components/copy-text-button";
import { ALERT_DISCLOSURE, CONSENT_METHODS } from "@/lib/inquiries";
import { cn } from "@/lib/utils";

// CRM Lite setup forms. Each posts to a server action that checks the caller
// is on the team; the database and the crm-lite function check again.

function Result({ state }: { state: CrmLiteState }) {
  if (!state) return null;
  return <span role="status" className={cn("text-xs", state.ok ? "text-green-800" : "text-red-700")}>{state.message}</span>;
}
const label = "block text-xs font-medium text-muted-foreground";
const select = "h-9 w-full rounded-lg border border-input bg-card px-2 text-sm";

export function CrmLiteSettingsForm({ clientId, enabled, portalEnabled, displayName, notes }: {
  clientId: string; enabled: boolean; portalEnabled: boolean; displayName: string | null; notes: string | null;
}) {
  const [state, action, pending] = useActionState<CrmLiteState, FormData>(saveCrmLiteSettingsAction.bind(null, clientId), null);
  return (
    <form action={action} className="space-y-3 text-sm">
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" name="enabled" defaultChecked={enabled} className="size-4" /> CRM Lite on (accept website inquiries)
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" name="portal_enabled" defaultChecked={portalEnabled} className="size-4" />
        The client&apos;s portal sign-ins see and follow up their own inquiries
      </label>
      <div>
        <label className={label} htmlFor="display_name">Business name in alerts</label>
        <Input id="display_name" name="display_name" defaultValue={displayName ?? ""} placeholder="Defaults to the client's name" />
      </div>
      <div>
        <label className={label} htmlFor="crm_notes">Notes</label>
        <Textarea id="crm_notes" name="notes" defaultValue={notes ?? ""} rows={2} />
      </div>
      <div className="flex items-center gap-3"><Button type="submit" disabled={pending}>Save</Button><Result state={state} /></div>
    </form>
  );
}

export function SourceForm({ clientId }: { clientId: string }) {
  const [state, action, pending] = useActionState<CrmLiteState, FormData>(createSourceAction.bind(null, clientId), null);
  return (
    <form action={action} className="grid gap-2 text-sm sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
      <div><label className={label} htmlFor="source_key">Key</label><Input id="source_key" name="source_key" placeholder="ginger-huff-website" required /></div>
      <div><label className={label} htmlFor="source_label">Label</label><Input id="source_label" name="label" placeholder="Website contact form" /></div>
      <div><label className={label} htmlFor="site_url">Site</label><Input id="site_url" name="site_url" placeholder="https://www.example.com" /></div>
      <Button type="submit" disabled={pending}>Add source</Button>
      <div className="sm:col-span-4"><Result state={state} /></div>
    </form>
  );
}

export function SourceControls({ clientId, sourceId, enabled, isAdmin, secretName }: {
  clientId: string; sourceId: string; enabled: boolean; isAdmin: boolean; secretName: string;
}) {
  const [toggle, toggleAction] = useActionState<CrmLiteState, FormData>(setSourceEnabledAction.bind(null, clientId, sourceId, !enabled), null);
  const [issued, issueAction] = useActionState<CrmLiteState, FormData>(issueIntakeTokenAction.bind(null, clientId, sourceId), null);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <form action={toggleAction}><Button type="submit" size="sm" variant="outline">{enabled ? "Disable" : "Enable"}</Button></form>
        {isAdmin && (
          <form action={issueAction} onSubmit={(e) => {
            if (!confirm(`Issue a new token for this source? Any token already in the website's ${secretName.replace("CRM_INTAKE_", "")} configuration stops working.`)) e.preventDefault();
          }}>
            <Button type="submit" size="sm" variant="outline">Issue / rotate token</Button>
          </form>
        )}
        <Result state={toggle} />
      </div>
      {issued && (
        <div className={cn("rounded-lg border p-3 text-xs", issued.ok ? "border-amber-300 bg-amber-50" : "border-red-200 bg-red-50")}>
          <p>{issued.message}</p>
          {issued.token && (
            <div className="mt-2 space-y-2">
              <code className="block break-all rounded bg-white p-2 font-mono" data-intake-token>{issued.token}</code>
              <CopyTextButton text={issued.token} label="Copy token" />
              <p>Paste it into the website&apos;s server environment as <code>CRM_INTAKE_TOKEN</code> (Vercel, Production, sensitive). Never in browser code.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SenderForm({ clientId, sender }: {
  clientId: string;
  sender: { id: string; sender_key: string; label: string; provider_account_sid: string; phone_e164: string; messaging_service_sid: string | null;
    verification_status: string; verification_sid: string | null; verification_evidence: string | null; enabled: boolean } | null;
}) {
  const [state, action, pending] = useActionState<CrmLiteState, FormData>(saveSenderAction.bind(null, sender?.id ?? null, clientId), null);
  return (
    <form action={action} className="grid gap-2 text-sm sm:grid-cols-2">
      {!sender && <div><label className={label} htmlFor="sender_key">Key</label><Input id="sender_key" name="sender_key" defaultValue="compass_notifications" /></div>}
      <div><label className={label} htmlFor="sender_label">Label</label><Input id="sender_label" name="label" defaultValue={sender?.label ?? "Compass - Notifications"} /></div>
      <div><label className={label} htmlFor="sender_account">Twilio subaccount SID</label><Input id="sender_account" name="provider_account_sid" defaultValue={sender?.provider_account_sid ?? ""} placeholder="AC…" required /></div>
      <div><label className={label} htmlFor="sender_phone">Sender number</label><Input id="sender_phone" name="phone_e164" defaultValue={sender?.phone_e164 ?? ""} placeholder="+1888…" required /></div>
      <div><label className={label} htmlFor="sender_mg">Messaging Service SID (optional)</label><Input id="sender_mg" name="messaging_service_sid" defaultValue={sender?.messaging_service_sid ?? ""} placeholder="MG…" /></div>
      <div>
        <label className={label} htmlFor="sender_status">Toll-free verification (as Twilio shows it)</label>
        <select id="sender_status" name="verification_status" defaultValue={sender?.verification_status ?? "pending_review"} className={select}>
          {["not_submitted", "pending_review", "in_review", "approved", "rejected"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
        </select>
      </div>
      <div><label className={label} htmlFor="sender_hh">Verification SID</label><Input id="sender_hh" name="verification_sid" defaultValue={sender?.verification_sid ?? ""} placeholder="HH…" /></div>
      <div className="sm:col-span-2"><label className={label} htmlFor="sender_evidence">Evidence (required for approved)</label>
        <Textarea id="sender_evidence" name="verification_evidence" rows={2} defaultValue={sender?.verification_evidence ?? ""} placeholder="e.g. Twilio Console › Toll-free verifications shows TWILIO_APPROVED on <date>" /></div>
      <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" name="enabled" defaultChecked={sender?.enabled ?? false} className="size-4" /> Sender enabled (only once approved)</label>
      <div className="flex items-center gap-3 sm:col-span-2"><Button type="submit" disabled={pending}>{sender ? "Save sender" : "Add sender"}</Button><Result state={state} /></div>
    </form>
  );
}

export function ChooseSenderForm({ clientId, senders, current }: { clientId: string; senders: { id: string; label: string; phone_e164: string }[]; current: string | null }) {
  const [state, action, pending] = useActionState<CrmLiteState, FormData>(chooseSenderAction.bind(null, clientId), null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2 text-sm">
      <div className="min-w-56">
        <label className={label} htmlFor="choose_sender">This client&apos;s alert sender</label>
        <select id="choose_sender" name="sender_id" defaultValue={current ?? ""} className={select}>
          <option value="">None</option>
          {senders.map((s) => <option key={s.id} value={s.id}>{s.label} ({s.phone_e164})</option>)}
        </select>
      </div>
      <Button type="submit" variant="outline" disabled={pending}>Choose</Button>
      <Result state={state} />
    </form>
  );
}

export function RecipientForm({ clientId }: { clientId: string }) {
  const [state, action, pending] = useActionState<CrmLiteState, FormData>(addRecipientAction.bind(null, clientId), null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => { if (state?.ok) ref.current?.reset(); }, [state]);
  return (
    <form ref={ref} action={action} className="grid gap-2 text-sm sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
      <div><label className={label} htmlFor="rcpt_name">Name</label><Input id="rcpt_name" name="name" placeholder="Owner's mobile" required /></div>
      <div><label className={label} htmlFor="rcpt_phone">Mobile</label><Input id="rcpt_phone" name="phone" placeholder="(618) 555-0100" required /></div>
      <div>
        <label className={label} htmlFor="rcpt_link">Link in the text opens</label>
        <select id="rcpt_link" name="link_target" defaultValue="portal" className={select}>
          <option value="portal">Client portal</option>
          <option value="crm">Compass CRM (teammates)</option>
        </select>
      </div>
      <Button type="submit" disabled={pending}>Add recipient</Button>
      <div className="sm:col-span-4"><Result state={state} /></div>
    </form>
  );
}

export function RecipientToggle({ clientId, recipientId, enabled }: { clientId: string; recipientId: string; enabled: boolean }) {
  const [state, action] = useActionState<CrmLiteState, FormData>(setRecipientEnabledAction.bind(null, clientId, recipientId, !enabled), null);
  return <form action={action} className="inline"><Button type="submit" size="xs" variant="outline">{enabled ? "Turn off" : "Turn on"}</Button> <Result state={state} /></form>;
}

// Records exactly what the recipient said. Nothing is pre-filled except the
// published disclosure version and link, which the teammate confirms.
export function ConsentForm({ clientId, recipientId }: { clientId: string; recipientId: string }) {
  const [state, action, pending] = useActionState<CrmLiteState, FormData>(recordAlertConsentAction.bind(null, clientId, recipientId), null);
  return (
    <form action={action} className="grid gap-2 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-2" data-consent-form>
      <input type="hidden" name="status" value="granted" />
      <div><label className={label} htmlFor={`c_at_${recipientId}`}>Date consent was given</label><Input id={`c_at_${recipientId}`} type="date" name="consented_at" required /></div>
      <div>
        <label className={label} htmlFor={`c_m_${recipientId}`}>How</label>
        <select id={`c_m_${recipientId}`} name="consent_method" required defaultValue="" className={select}>
          <option value="" disabled>Choose…</option>
          {CONSENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>
      <div className="sm:col-span-2"><label className={label} htmlFor={`c_r_${recipientId}`}>The recipient&apos;s actual response (their words)</label>
        <Textarea id={`c_r_${recipientId}`} name="consent_response" rows={2} required /></div>
      <div><label className={label} htmlFor={`c_v_${recipientId}`}>Disclosure version shown</label><Input id={`c_v_${recipientId}`} name="disclosure_version" defaultValue={ALERT_DISCLOSURE.version} required /></div>
      <div><label className={label} htmlFor={`c_u_${recipientId}`}>Disclosure link</label><Input id={`c_u_${recipientId}`} name="disclosure_url" defaultValue={ALERT_DISCLOSURE.url} /></div>
      <label className="flex items-start gap-2 sm:col-span-2">
        <input type="checkbox" name="disclosure_acknowledged" className="mt-0.5 size-4" />
        <span>The recipient was shown the {ALERT_DISCLOSURE.program} disclosure (sender, purpose, frequency, rates, STOP / HELP) and acknowledged it.</span>
      </label>
      <div className="sm:col-span-2"><label className={label} htmlFor={`c_d_${recipientId}`}>Notes (optional)</label><Input id={`c_d_${recipientId}`} name="detail" /></div>
      <div className="flex items-center gap-3 sm:col-span-2"><Button type="submit" disabled={pending}>Record consent</Button><Result state={state} /></div>
    </form>
  );
}

export function DeliveryTestForm({ clientId, recipientId }: { clientId: string; recipientId: string }) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [state, action, pending] = useActionState<CrmLiteState, FormData>(sendDeliveryTestAction.bind(null, clientId, recipientId), null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2" onSubmit={(e) => {
      if (!confirm("Send one real test text to this recipient now?")) e.preventDefault();
    }}>
      <input type="hidden" name="request_id" value={requestId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>Send delivery test</Button>
      <Result state={state} />
    </form>
  );
}

export function ConfirmTestForm({ clientId, recipientId, jobId }: { clientId: string; recipientId: string; jobId: string }) {
  const [state, action, pending] = useActionState<CrmLiteState, FormData>(confirmDeliveryTestAction.bind(null, clientId, recipientId, jobId), null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2 text-sm">
      <label className="flex items-center gap-2"><input type="checkbox" name="received" className="size-4" /> The recipient confirmed they received it</label>
      <Button type="submit" size="sm" disabled={pending}>Confirm test</Button>
      <Result state={state} />
    </form>
  );
}

export function SmsSwitch({ clientId, enabled, ready }: { clientId: string; enabled: boolean; ready: boolean }) {
  const [state, action, pending] = useActionState<CrmLiteState, FormData>(setSmsAlertsAction.bind(null, clientId, !enabled), null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3" onSubmit={(e) => {
      if (!enabled && !confirm("Turn SMS alerts on for NEW inquiries? Inquiries already saved are never texted.")) e.preventDefault();
    }}>
      <Button type="submit" variant={enabled ? "outline" : "accent"} disabled={pending || (!enabled && !ready)}>
        {enabled ? "Turn SMS alerts off" : "Turn SMS alerts on"}
      </Button>
      <Result state={state} />
    </form>
  );
}
