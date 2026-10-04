// Billing operations helpers (B3). Pure: shared by the billing server
// actions, the Billing tab, Settings › Billing catalog and the tests.
//
// Every Stripe write goes through the stripe-billing Edge Function, which
// resolves the client, customer, price and amount itself; these helpers only
// shape what a teammate typed and word what the function answered.

import { parseMoneyToCents } from "./billing.ts";

export type BillingAnswer = { status: number | null; body: Record<string, unknown> | null };

// What the function's refusal means, in words a teammate can act on. The
// function's own `detail` is written for people, so it wins when present.
const codeText: Record<string, string> = {
  not_signed_in: "Your session expired. Sign in again and retry.",
  forbidden: "You aren't allowed to do that.",
  admin_only: "Only an admin can do that.",
  stripe_not_configured: "Stripe is not connected yet (no Stripe key in Vault).",
  live_mode_not_enabled: "The Stripe key is a live key, but billing is still in test mode.",
  key_mode_mismatch: "Billing is in live mode, but the Stripe key is a test key.",
  stripe_error: "Stripe refused the request.",
};

export function billingAnswerText(a: BillingAnswer): string {
  if (a.status == null) return "Could not reach the billing function. Check the Billing tab before retrying: the action may have gone through.";
  const code = typeof a.body?.error === "string" ? a.body.error : null;
  const detail = typeof a.body?.detail === "string" ? a.body.detail : null;
  if (code === "stripe_error") return `Stripe refused the request: ${detail ?? "no detail"}`;
  if (detail) return detail;
  if (code && codeText[code]) return codeText[code];
  return `The billing function answered ${a.status}.`;
}

export const isOk = (a: BillingAnswer) => a.status === 200;

// "month" / "3 months" / "year".
export function intervalText(interval: string | null | undefined, count: number | null | undefined): string {
  if (!interval) return "one time";
  const n = count ?? 1;
  return n === 1 ? interval : `${n} ${interval}s`;
}

export function modeLabel(livemode: boolean): string {
  return livemode ? "Live mode" : "Test mode";
}

// A Checkout link is usable while Stripe says open and it has not expired.
export function linkIsOpen(cs: { status: string; url: string | null; expires_at: string }, now = new Date()): boolean {
  return cs.status === "open" && !!cs.url && new Date(cs.expires_at) > now;
}

// ── Form readers ───────────────────────────────────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export type ExternalPaymentInput = {
  amount: string | null;
  currency: string | null;
  method: string | null;
  paid_at: string | null;
  reference: string | null;
  notes: string | null;
  request_id: string | null;
};

// The same rules as the function and 0060, with reasons to act on.
export function readExternalPayment(input: ExternalPaymentInput, today = new Date()):
  | { body: { amount_cents: number; currency: string; method: string; paid_at: string; reference: string | null; notes: string; request_id: string } }
  | { error: string } {
  const currency = (input.currency || "usd").trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) return { error: "Currency is a three-letter code (usd)." };
  const cents = parseMoneyToCents(input.amount, currency);
  if (cents == null || cents === "invalid" || cents <= 0) return { error: "Enter the amount received." };
  if (!["check", "wire", "ach_manual", "other"].includes(input.method ?? "")) return { error: "Choose how the payment arrived." };
  const paid = input.paid_at ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paid) || Number.isNaN(Date.parse(paid))) return { error: "Enter the date the payment arrived." };
  if (Date.parse(paid) > today.getTime() + 86_400_000) return { error: "The payment date is in the future." };
  const notes = input.notes?.trim() ?? "";
  if (!notes) return { error: "Add a note: what the payment was for." };
  if (!isUuid(input.request_id)) return { error: "The form expired. Reload the page and try again." };
  return {
    body: { amount_cents: cents, currency, method: input.method!, paid_at: paid, reference: input.reference?.trim() || null, notes, request_id: input.request_id },
  };
}

export function readCustomPrice(input: { amount: string | null; interval: string | null; nickname: string | null; request_id: string | null }):
  | { body: { amount_cents: number; currency: "usd"; interval: "month" | "year"; interval_count: 1; nickname: string | null; request_id: string } }
  | { error: string } {
  const cents = parseMoneyToCents(input.amount, "usd");
  if (cents == null || cents === "invalid" || cents <= 0) return { error: "Enter the agreed amount." };
  if (input.interval !== "month" && input.interval !== "year") return { error: "A retainer is billed per month or per year." };
  if (!isUuid(input.request_id)) return { error: "The form expired. Reload the page and try again." };
  return { body: { amount_cents: cents, currency: "usd", interval: input.interval, interval_count: 1, nickname: input.nickname?.trim() || null, request_id: input.request_id } };
}

// ── Catalog ────────────────────────────────────────────────────────────────
export type PackageInput = { key: string | null; name: string | null; description: string | null; kind: string | null; sort_order: string | null };

export function readPackage(input: PackageInput):
  | { row: { key: string; name: string; description: string | null; kind: "standard" | "custom"; sort_order: number } }
  | { error: string } {
  const key = (input.key ?? "").trim();
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(key)) return { error: "The key is lower-case letters, digits and underscores (growth_plus)." };
  const name = (input.name ?? "").trim();
  if (!name) return { error: "Give the package a name." };
  if (input.kind !== "standard" && input.kind !== "custom") return { error: "Choose standard or custom." };
  const sort = input.sort_order?.trim() ? Number(input.sort_order) : 0;
  if (!Number.isInteger(sort)) return { error: "Sort order is a whole number." };
  return { row: { key, name, description: input.description?.trim() || null, kind: input.kind, sort_order: sort } };
}

// What a package includes for one service: a feature is on or off; a quota
// is included exactly when it has a whole-number monthly quantity.
export function readEntitlement(kind: string, enabled: boolean, quantity: string | null):
  | { enabled: boolean; quantity: number | null }
  | { error: string } {
  if (kind === "feature") return { enabled, quantity: null };
  if (!enabled) return { enabled: false, quantity: null };
  const q = quantity?.trim() ? Number(quantity) : NaN;
  if (!Number.isInteger(q) || q < 0) return { error: "An included quota needs a whole-number quantity." };
  return { enabled: true, quantity: q };
}

export const oneTimeCategoryLabels: Record<string, string> = {
  website_project: "Website project",
  setup_fee: "Setup fee",
  special_project: "Special project",
  other: "Other",
};

export function readOneTimeItem(input: { key: string | null; name: string | null; description: string | null; category: string | null }):
  | { row: { key: string; name: string; description: string | null; category: string } }
  | { error: string } {
  const key = (input.key ?? "").trim();
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(key)) return { error: "The key is lower-case letters, digits and underscores (website_build)." };
  const name = (input.name ?? "").trim();
  if (!name) return { error: "Give the item a name." };
  if (!oneTimeCategoryLabels[input.category ?? ""]) return { error: "Choose a category." };
  return { row: { key, name, description: input.description?.trim() || null, category: input.category! } };
}

// ── Audit trail wording ────────────────────────────────────────────────────
export const auditActionLabels: Record<string, string> = {
  link_customer: "Linked an existing Stripe customer",
  create_customer: "Created the Stripe customer",
  resync_customer: "Re-read everything from Stripe",
  import_product: "Imported a Stripe product",
  create_custom_price: "Created a custom retainer price",
  create_checkout: "Created a payment link",
  expire_checkout: "Expired a payment link",
  configure_portal: "Configured the Customer Portal",
  portal_session: "Opened the Customer Portal",
  record_external_payment: "Recorded an external payment",
  void_external_payment: "Voided an external payment",
};
