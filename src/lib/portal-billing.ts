// Client-facing billing wording for the portal (B5). Pure. The portal never
// sees Stripe ids, internal attention codes or reconciliation state: the
// portal_billing_summary view (0062) already reduces the billing state to one
// of these client-safe codes.

export type PortalBillingStatus =
  | "active" | "trial" | "payment_attention" | "payment_pending" | "scheduled_to_end" | "ended"
  | "external" | "awaiting_setup" | "paused" | "not_set_up";

export const portalStatusLabels: Record<PortalBillingStatus, string> = {
  active: "Active",
  trial: "Trial",
  payment_attention: "Payment needs attention",
  payment_pending: "First payment pending",
  scheduled_to_end: "Scheduled to end",
  ended: "Ended",
  external: "Managed directly with Compass",
  awaiting_setup: "Waiting for your payment details",
  paused: "Paused",
  not_set_up: "Not set up yet",
};

export const portalStatusStyles: Record<PortalBillingStatus, string> = {
  active: "bg-green-100 text-green-800 border-green-200",
  trial: "bg-blue-100 text-blue-800 border-blue-200",
  payment_attention: "bg-amber-100 text-amber-900 border-amber-200",
  payment_pending: "bg-amber-100 text-amber-900 border-amber-200",
  scheduled_to_end: "bg-amber-100 text-amber-900 border-amber-200",
  ended: "bg-zinc-100 text-zinc-600 border-zinc-200",
  external: "bg-zinc-100 text-zinc-700 border-zinc-200",
  awaiting_setup: "bg-blue-100 text-blue-800 border-blue-200",
  paused: "bg-zinc-100 text-zinc-700 border-zinc-200",
  not_set_up: "bg-zinc-100 text-zinc-600 border-zinc-200",
};

export function portalStatus(value: string | null | undefined): PortalBillingStatus {
  return value && value in portalStatusLabels ? (value as PortalBillingStatus) : "not_set_up";
}

// What the status means for the client, in a sentence (or nothing).
export function portalStatusHelp(status: PortalBillingStatus): string | null {
  switch (status) {
    case "payment_attention": return "Your last payment didn't go through. Use Manage billing to update your payment method, or reply to your last email from Compass.";
    case "payment_pending": return "Your first payment is on its way. Bank payments can take a few business days to clear.";
    case "external": return "Billing is managed directly with Compass.";
    case "awaiting_setup": return "We've sent you a secure payment link. Once it's complete, your billing details will appear here.";
    case "scheduled_to_end": return "Your plan is scheduled to end. Reply to your last email from Compass if that isn't what you expected.";
    default: return null;
  }
}

export const invoiceStatusLabels: Record<string, string> = {
  paid: "Paid",
  open: "Due",
  uncollectible: "Unpaid",
  void: "Void",
};

// The only message a portal user sees when billing management cannot open:
// nothing internal (no function error, no Stripe detail).
export const MANAGE_BILLING_UNAVAILABLE =
  "We couldn't open billing management just now. Please try again in a few minutes, or reply to your last email from Compass.";
