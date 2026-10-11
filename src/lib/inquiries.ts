// CRM Lite: shared, pure rules for the inquiry workspace (agency and client
// portal) and the alert setup. The database enforces every rule again
// (20261011220000_crm_lite.sql); this decides what to show.

export const INQUIRY_STATUSES = ["new", "contacted", "closed"] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

export function isInquiryStatus(v: unknown): v is InquiryStatus {
  return typeof v === "string" && (INQUIRY_STATUSES as readonly string[]).includes(v);
}

export const INQUIRY_STATUS_LABELS: Record<InquiryStatus, string> = {
  new: "New",
  contacted: "Contacted",
  closed: "Closed",
};

export const INQUIRY_STATUS_STYLES: Record<InquiryStatus, string> = {
  new: "bg-orange-100 text-orange-900 border-orange-200",
  contacted: "bg-blue-100 text-blue-900 border-blue-200",
  closed: "bg-zinc-100 text-zinc-700 border-zinc-200",
};

// The buttons a person sees for an inquiry in a given status: the next step
// first, and Reopen for a closed one.
export function statusActions(status: InquiryStatus): { to: InquiryStatus; label: string; primary: boolean }[] {
  if (status === "new") return [
    { to: "contacted", label: "Mark contacted", primary: true },
    { to: "closed", label: "Close", primary: false },
  ];
  if (status === "contacted") return [
    { to: "closed", label: "Close", primary: true },
    { to: "new", label: "Back to new", primary: false },
  ];
  return [{ to: "new", label: "Reopen", primary: true }];
}

// A search term safe to put inside a PostgREST or() filter: letters, digits
// and the few characters names, emails and phones use. Commas, parentheses,
// asterisks and quotes would change the filter's meaning, so they go.
export function searchTerm(raw: string | null | undefined): string {
  return (raw ?? "").replace(/[^\p{L}\p{N}@.+\-_' ]/gu, " ").replace(/'/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

// The or() filter for name, email or phone. Digits typed as a phone number
// ("618 791 9113") also match the stored E.164 form.
export function searchFilter(term: string): string | null {
  const t = searchTerm(term);
  if (!t) return null;
  const parts = [`name.ilike.*${t}*`, `email.ilike.*${t}*`, `phone.ilike.*${t}*`];
  const digits = t.replace(/\D/g, "");
  if (digits.length >= 4) parts.push(`phone_e164.ilike.*${digits}*`);
  return parts.join(",");
}

export function telHref(phoneE164: string | null | undefined, raw?: string | null): string | null {
  if (phoneE164) return `tel:${phoneE164}`;
  const digits = (raw ?? "").replace(/[^\d+]/g, "");
  return digits.length >= 7 ? `tel:${digits}` : null;
}

export function mailtoHref(email: string | null | undefined, businessName: string): string | null {
  if (!email) return null;
  return `mailto:${encodeURIComponent(email).replace(/%40/g, "@")}?subject=${encodeURIComponent(`Your inquiry with ${businessName}`)}`;
}

export function formatWhen(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
  });
}

// "code: message" from the database, in plain words.
const REFUSALS: Record<string, string> = {
  changed: "Someone else just changed this inquiry. The page has been refreshed; check it and try again.",
  not_found: "That inquiry isn't available.",
  forbidden: "You don't have access to that.",
  empty: "Write something first.",
  too_long: "That's too long.",
  invalid: "That isn't a valid choice.",
  incomplete: "The consent record is incomplete.",
  opted_out: "This number texted STOP. Only the recipient can lift that (by texting START), and consent is then recorded again.",
  sender_not_approved: "The alert sender's toll-free verification is not recorded as approved and enabled.",
  no_ready_recipient: "No recipient has complete consent and a confirmed delivery test from this sender.",
  not_enabled: "CRM Lite is not enabled for this client.",
  not_delivered: "Twilio has not reported the test as delivered yet.",
  blocked: "A gate is still closed for this recipient.",
};

export function refusalCode(message: string | null | undefined): string | null {
  return (message ?? "").match(/^([a-z_]+):/)?.[1] ?? null;
}

export function refusalText(message: string | null | undefined): string {
  const code = refusalCode(message);
  if (code && REFUSALS[code]) {
    const detail = (message ?? "").slice(code.length + 1).trim();
    return code === "incomplete" || code === "blocked" ? `${REFUSALS[code]} ${detail}` : REFUSALS[code];
  }
  return "That didn't work. Try again, or ask a Compass admin.";
}

// ── Alerts ─────────────────────────────────────────────────────────────────
export const BLOCK_REASON_LABELS: Record<string, string> = {
  crm_lite_off: "CRM Lite is off for this client",
  sms_alerts_off: "SMS alerts were off for this client",
  no_sender: "No alert sender chosen",
  sender_not_approved: "Sender's toll-free verification not approved",
  sender_disabled: "Sender not enabled",
  recipient_disabled: "Recipient turned off",
  opted_out: "Recipient texted STOP",
  consent_incomplete: "Consent record not complete",
  delivery_test_not_confirmed: "Delivery test not confirmed",
  stale: "Older than 24 hours when it could have gone out",
  sender_changed: "The client's alert sender changed",
  recipient_missing: "Recipient removed",
};

export const JOB_STATUS_LABELS: Record<string, string> = {
  blocked: "Not sent (gate closed)",
  queued: "Waiting to send",
  sending: "Sending",
  unknown: "Checking with Twilio",
  sent: "Sent",
  failed: "Failed",
};

export const CONSENT_METHODS = [
  { value: "verbal", label: "Verbal (phone or in person)" },
  { value: "written", label: "Written (signed)" },
  { value: "email", label: "Email reply" },
  { value: "text_reply", label: "Text reply" },
  { value: "web_form", label: "Web form" },
  { value: "other", label: "Other" },
] as const;

// The disclosure published at compassmarketing.ai/sms-consent.html.
export const ALERT_DISCLOSURE = {
  version: "2026-10-11",
  url: "https://www.compassmarketing.ai/sms-consent.html",
  program: "Compass CRM inquiry alerts",
};

export type GateInput = {
  settingsEnabled: boolean;
  smsAlertsEnabled: boolean;
  sender: { verification_status: string; enabled: boolean } | null;
  senderCredentialsPresent: boolean | null;
  recipients: { consent_status: string; enabled: boolean; delivery_test_confirmed_at: string | null }[];
};

// The four go-live conditions, in order, for the setup page.
export function alertGates(g: GateInput): { key: string; label: string; ok: boolean }[] {
  const ready = g.recipients.filter((r) => r.enabled && r.consent_status === "granted");
  return [
    { key: "sender_approved", label: "Twilio toll-free verification recorded approved, sender enabled",
      ok: !!g.sender && g.sender.verification_status === "approved" && g.sender.enabled },
    { key: "credentials", label: "Sender's API key and Auth Token in Vault", ok: g.senderCredentialsPresent === true },
    { key: "consent", label: "A recipient's consent record is complete", ok: ready.length > 0 },
    { key: "delivery_test", label: "An authorized delivery test was delivered and confirmed",
      ok: ready.some((r) => !!r.delivery_test_confirmed_at) },
  ];
}

export function inquiryPath(scope: "portal" | { clientId: string }, inquiryId?: string): string {
  const base = scope === "portal" ? "/portal/inquiries" : `/clients/${scope.clientId}/inquiries`;
  return inquiryId ? `${base}/${inquiryId}` : base;
}
