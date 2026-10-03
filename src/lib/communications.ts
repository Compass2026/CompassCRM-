// Compass Communications (0063): the pure rules shared by the app and the
// communications / twilio-webhook Edge Functions. No I/O, no credentials.
//
// Twilio's own statuses are stored verbatim (provider_status) and mapped
// here to the few states Compass shows; nothing is invented on Twilio's
// behalf. The client-level pipeline (not_configured → … → approved) is
// derived from the registry and the registrations, never stored.

// ── Phone numbers ───────────────────────────────────────────────────────────
const E164 = /^\+[1-9][0-9]{7,14}$/;

export function isE164(value: string | null | undefined): boolean {
  return !!value && E164.test(value);
}

// A US / NANP number typed by a person → E.164, or null. "+" numbers are
// taken as they are when valid; anything else must be 10 digits (or 11 with
// a leading 1). International entry is out of scope for Phase 1.
export function normalizeUsPhone(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("+")) {
    const compact = "+" + raw.slice(1).replace(/[^0-9]/g, "");
    return isE164(compact) ? compact : null;
  }
  const digits = raw.replace(/[^0-9]/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length !== 10 || !/^[2-9][0-9]{2}[2-9]/.test(ten)) return null;
  return "+1" + ten;
}

// "+18005550100" → "(800) 555-0100"; anything else unchanged.
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const m = /^\+1([0-9]{3})([0-9]{3})([0-9]{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export const TOLL_FREE_PREFIXES = ["800", "833", "844", "855", "866", "877", "888"] as const;

export function isUsTollFree(e164: string | null | undefined): boolean {
  const m = /^\+1([0-9]{3})[0-9]{7}$/.exec(e164 ?? "");
  return !!m && (TOLL_FREE_PREFIXES as readonly string[]).includes(m[1]);
}

// ── Opt-out keywords ────────────────────────────────────────────────────────
// Twilio handles the reply to these (its default opt-out handling, or
// Advanced Opt-Out). Compass only records the recipient's choice: from
// Twilio's OptOutType parameter when present, else from these standard
// keywords. Compass never sends its own STOP / HELP reply.
const STOP_WORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"];
const START_WORDS = ["START", "YES", "UNSTOP"];
const HELP_WORDS = ["HELP", "INFO"];

export type OptOutType = "STOP" | "START" | "HELP";

export function optOutKeyword(body: string | null | undefined): OptOutType | null {
  const word = (body ?? "").trim().toUpperCase().replace(/[.!]+$/, "");
  if (STOP_WORDS.includes(word)) return "STOP";
  if (START_WORDS.includes(word)) return "START";
  if (HELP_WORDS.includes(word)) return "HELP";
  return null;
}

export function optOutFromTwilio(value: string | null | undefined): OptOutType | null {
  const v = (value ?? "").trim().toUpperCase();
  return v === "STOP" || v === "START" || v === "HELP" ? v : null;
}

// ── Message status ──────────────────────────────────────────────────────────
// Mirrors communication_status_rank() (0063): a status only moves forward.
const RANK: Record<string, number> = {
  pending: 0, accepted: 1, scheduled: 1, queued: 2, sending: 3, sent: 4, receiving: 4, received: 5,
  delivered: 6, undelivered: 6, failed: 6, canceled: 6, partially_delivered: 6, read: 7,
};

export function messageStatusRank(status: string | null | undefined): number {
  return status != null && status in RANK ? RANK[status] : -1;
}

export function isKnownMessageStatus(status: string | null | undefined): boolean {
  return messageStatusRank(status) >= 0;
}

export function messageStatusLabel(status: string, direction: "inbound" | "outbound"): string {
  if (direction === "inbound") return "Received";
  switch (status) {
    case "pending": return "Sending…";
    case "accepted": case "scheduled": case "queued": case "sending": return "Queued";
    case "sent": return "Sent";
    case "delivered": case "read": return "Delivered";
    case "undelivered": return "Not delivered";
    case "failed": return "Failed";
    case "canceled": return "Canceled";
    default: return status;
  }
}

// ── Compliance registrations ────────────────────────────────────────────────
export type RegistrationStatus = "draft" | "pending_review" | "in_review" | "approved" | "rejected";

// Secondary customer profile (TrustHub): draft, pending-review, in-review,
// twilio-approved, twilio-rejected.
export function mapCustomerProfileStatus(raw: string | null | undefined): RegistrationStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "pending-review": return "pending_review";
    case "in-review": return "in_review";
    case "twilio-approved": return "approved";
    case "twilio-rejected": return "rejected";
    default: return "draft";
  }
}

// Toll-free verification: PENDING_REVIEW, IN_REVIEW, TWILIO_APPROVED,
// TWILIO_REJECTED.
export function mapTollFreeStatus(raw: string | null | undefined): RegistrationStatus {
  switch ((raw ?? "").toUpperCase()) {
    case "PENDING_REVIEW": return "pending_review";
    case "IN_REVIEW": return "in_review";
    case "TWILIO_APPROVED": return "approved";
    case "TWILIO_REJECTED": return "rejected";
    default: return "draft";
  }
}

// ── The client's messaging pipeline ─────────────────────────────────────────
export const PIPELINE_STATUSES = [
  "not_configured", "profile_pending", "profile_approved", "number_purchased",
  "verification_pending", "verification_in_review", "approved", "rejected", "restricted", "blocked",
] as const;
export type PipelineStatus = typeof PIPELINE_STATUSES[number];

export const PIPELINE_LABELS: Record<PipelineStatus, string> = {
  not_configured: "Not configured",
  profile_pending: "Business profile pending",
  profile_approved: "Business profile approved",
  number_purchased: "Number purchased",
  verification_pending: "Verification submitted",
  verification_in_review: "Verification in review",
  approved: "Approved",
  rejected: "Rejected",
  restricted: "Restricted",
  blocked: "Blocked",
};

export type RegistrationLike = {
  profile_type: "secondary_customer_profile" | "toll_free_verification";
  status: RegistrationStatus;
  provider_profile_sid: string | null;
  restriction: "restricted" | "blocked" | null;
  communication_number_id: string | null;
};
export type NumberLike = { id: string; is_primary: boolean; status: "active" | "released"; sms_enabled: boolean };

// One answer for "where is this client's SMS setup": the primary number's
// toll-free verification decides once it exists; before that, the business
// profile; a teammate's restriction overrides everything. Twilio statuses
// map one-to-one; restricted / blocked are Compass's own (Twilio has no
// such verification state).
export function pipelineStatus(input: {
  hasAccount: boolean;
  registrations: RegistrationLike[];
  numbers: NumberLike[];
}): PipelineStatus {
  const regs = input.registrations;
  if (regs.some((r) => r.restriction === "blocked")) return "blocked";
  if (regs.some((r) => r.restriction === "restricted")) return "restricted";

  const active = input.numbers.filter((n) => n.status === "active");
  const primary = active.find((n) => n.is_primary) ?? active[0] ?? null;
  const tfv = regs.find((r) => r.profile_type === "toll_free_verification" && primary && r.communication_number_id === primary.id)
    ?? regs.find((r) => r.profile_type === "toll_free_verification" && r.provider_profile_sid);
  if (tfv && tfv.provider_profile_sid) {
    switch (tfv.status) {
      case "approved": return "approved";
      case "rejected": return "rejected";
      case "in_review": return "verification_in_review";
      default: return "verification_pending";
    }
  }
  if (primary) return "number_purchased";

  const profile = regs.find((r) => r.profile_type === "secondary_customer_profile");
  if (profile && profile.provider_profile_sid) {
    if (profile.status === "approved") return "profile_approved";
    if (profile.status === "rejected") return "rejected";
    return "profile_pending";
  }
  if (!input.hasAccount && !profile) return "not_configured";
  return profile ? "profile_pending" : "not_configured";
}

export const REGISTRATION_LABELS: Record<RegistrationStatus, string> = {
  draft: "Not submitted",
  pending_review: "Submitted",
  in_review: "In review",
  approved: "Approved",
  rejected: "Rejected",
};

// ── Consent ─────────────────────────────────────────────────────────────────
export type ConsentStatus = "granted" | "revoked" | "opted_out";
export const CONSENT_LABELS: Record<ConsentStatus | "none", string> = {
  granted: "Consent on record",
  revoked: "Consent revoked",
  opted_out: "Opted out (STOP)",
  none: "No consent on record",
};
export const CONSENT_SOURCES = [
  { value: "web_form", label: "Web form opt-in" },
  { value: "verbal", label: "Verbal (phone or in person)" },
  { value: "paper_form", label: "Paper form" },
  { value: "inbound_sms", label: "Customer texted first and asked for a reply" },
  { value: "import", label: "Imported with documented consent" },
  { value: "other", label: "Other (describe in evidence)" },
] as const;

// Whether a teammate may send to this recipient now (the database decides
// again under a lock; this only shapes the composer).
export function canSendTo(consent: ConsentStatus | null, anyOptedOut: boolean): { ok: true } | { ok: false; reason: string } {
  if (anyOptedOut) return { ok: false, reason: "This number texted STOP. Only the recipient can opt back in, by texting START." };
  if (consent === "granted") return { ok: true };
  if (consent === "revoked") return { ok: false, reason: "Consent was revoked. Record new consent before texting." };
  return { ok: false, reason: "No SMS consent on record. Record how this person agreed to be texted before sending." };
}

// ── Errors from the functions / database ────────────────────────────────────
// Database refusals arrive as "code: message".
export function refusalCode(message: string | null | undefined): string | null {
  const m = /^([a-z_]+):/.exec(message ?? "");
  return m ? m[1] : null;
}

const REFUSALS: Record<string, string> = {
  opted_out: "This recipient opted out (STOP). Only they can opt back in, by texting START.",
  no_consent: "There is no SMS consent on record for this recipient.",
  not_enabled: "Communications are not enabled for this client.",
  outbound_disabled: "Sending is turned off for this client (Communications › Settings).",
  no_number: "This client has no Compass number that can send SMS.",
  no_messaging_service: "The number is not in an active Messaging Service yet.",
  no_phone: "This contact has no mobile number.",
  empty: "The message is empty.",
  too_long: "A message is at most 1,600 characters.",
  no_evidence: "Record where or how the recipient agreed to be texted.",
};

export function refusalText(message: string | null | undefined): string {
  const code = refusalCode(message);
  return (code && REFUSALS[code]) || (message ?? "Something went wrong.").replace(/^[a-z_]+:\s*/, "");
}
