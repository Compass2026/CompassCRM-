// The CRM holds no Stripe or database credentials for public payment links.
// All token validation and Checkout operations belong to the billing project.
export type PaymentLinkAnswer = {
  error?: string; detail?: string; url?: string; id?: string; expires_at?: string;
  client_name?: string; state?: "ready" | "complete"; livemode?: boolean;
  agreement?: { agreed_amount_cents: number; agreed_currency: string; agreed_billing_interval: string; agreed_billing_interval_count: number };
};
export async function paymentLinkCall(body: Record<string, unknown>, jwt?: string): Promise<PaymentLinkAnswer> {
  const base = process.env.BILLING_API_URL?.trim().replace(/\/$/, "");
  if (!base || !/^https:\/\/[^\s/?#]+$/.test(base)) return { error: "unavailable", detail: "Payment setup is temporarily unavailable." };
  try {
    const res = await fetch(`${base}/api/payment-links`, { method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const answer = await res.json();
    return res.ok ? answer : { error: answer.error ?? "unavailable", detail: answer.detail ?? "Payment setup is unavailable." };
  } catch { return { error: "unavailable", detail: "Payment setup is temporarily unavailable. Please try again shortly." }; }
}
