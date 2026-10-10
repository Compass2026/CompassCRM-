export type AgreementScope = {
  client_name: string;
  plan: {
    package_id: string;
    collection: string;
    amount_cents: number;
    currency: string;
    interval: string;
    interval_count: number;
    start_date: string | null;
    term_months: number | null;
    managed_ad_budget_cents: number | null;
  };
  services: {
    name: string;
    quantity: number | null;
    unit: string | null;
    period: string | null;
  }[];
};
export type Contract = {
  id: string;
  client_id: string;
  title: string;
  recipient_name: string;
  recipient_email: string;
  status: "draft" | "issued" | "signed" | "declined" | "void";
  snapshot: {
    version: number;
    issuer_name: string;
    scope: AgreementScope;
    terms: string;
  };
  content_hash: string | null;
  provider_name: string | null;
  provider_signed_at: string | null;
  signer_name: string | null;
  signed_at: string | null;
  signer_ip: string | null;
  signer_agent: string | null;
  consent_text: string | null;
  issued_at: string | null;
  expires_at: string | null;
  created_at: string;
  payment_url: string | null;
  payment_expires_at: string | null;
  pdf_hash: string | null;
  events?: {
    id: number;
    kind: string;
    actor: string;
    created_at: string;
    detail: Record<string, unknown>;
  }[];
};
export const CONSENT_TEXT =
  "I have read this agreement, consent to electronic records and signatures, and am authorized to sign for the customer. Typing my name is my signature. I can download and retain a copy. Signing does not authorize a bank debit or card charge.";
const termHeadings = new Set([
  "Service terms", "Billing and separate payment authorization",
  "Additional charges and changes", "Text messaging email and CRM usage",
  "Authority and payment responsibility", "Cancellation and notices",
  "Compass mailing address for notices", "Transfer of files and records",
  "Billing questions", "Signatures and electronic records",
]);

// Presentation only: the approved snapshot and content hash remain untouched.
export function agreementTermBlocks(terms: string) {
  return terms.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((text) => ({
    text,
    heading: termHeadings.has(text.trim()),
  }));
}
export function agreementPrice(scope: AgreementScope): string {
  const p = scope.plan;
  if (p.amount_cents == null || !p.currency || !p.interval)
    return "Price not recorded";
  return `${new Intl.NumberFormat("en-US", { style: "currency", currency: p.currency }).format(p.amount_cents / 100)} / ${p.interval_count > 1 ? `${p.interval_count} ` : ""}${p.interval}${p.interval_count > 1 ? "s" : ""}`;
}
export function agreementStatus(
  c: Pick<Contract, "status" | "expires_at">,
  now = Date.now(),
): string {
  return c.status === "issued" && c.expires_at && Date.parse(c.expires_at) < now
    ? "expired"
    : c.status;
}
export function serviceLine(s: AgreementScope["services"][number]): string {
  return s.quantity == null
    ? s.name
    : `${s.name}: ${s.quantity} ${s.unit ?? ""} / ${s.period ?? "month"}`;
}
export function safePaymentUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "checkout.stripe.com"
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export function activeAgreementPayment(c: Contract): string | null {
  return c.payment_expires_at && Date.parse(c.payment_expires_at) > Date.now()
    ? safePaymentUrl(c.payment_url)
    : null;
}
export const agreementErrors: Record<string, string> = {
  unavailable:
    "This agreement link is unavailable or expired. Contact the sender for a new link.",
  verification_required:
    "Verify your email before reviewing or signing this agreement.",
  invalid_code: "That code did not match. Try again.",
  code_expired:
    "That code expired or reached its attempt limit. Request a new code.",
  code_rate_limited:
    "Please wait before requesting another code. Contact the sender if you need help.",
  consent_required:
    "Enter your full name and accept electronic signing to continue.",
  version_changed:
    "The agreement version did not match. Reload and review it again.",
};
