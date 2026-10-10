import { createHash, randomUUID } from "node:crypto";
import { checkCheckoutPrice, createStripeBilling, type PaymentCheckoutScope } from "../../supabase/functions/stripe-billing/handler.ts";
import type { BillingStore } from "../../supabase/functions/stripe-billing/store.ts";

export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export type PaymentLink = PaymentCheckoutScope & { expires_at: string; client_name: string; state: "ready" | "complete" };
export type PaymentLinkStore = {
  read(hash: string): Promise<PaymentLink | null>;
  write(input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
};
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
const unavailable = () => json(410, { error: "unavailable", detail: "This link is unavailable or expired. Ask Compass for a new payment link." });

export function createPaymentLinks(deps: {
  store: BillingStore; links: PaymentLinkStore; appUrl: string;
  checkout: ReturnType<typeof createStripeBilling>["checkoutForPaymentLink"];
}) {
  return async (req: Request) => {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "invalid_request" });
    try {
      if (body.action === "issue" || body.action === "revoke") {
        const caller = await deps.store.caller((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
        if (!caller || caller === "none" || caller.kind !== "team" || caller.role !== "admin") return json(403, { error: "admin_only" });
        if (typeof body.client_id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.client_id)) return json(400, { error: "invalid_request" });
        if (body.action === "revoke") {
          await deps.links.write({ op: "revoke", client_id: body.client_id, actor_id: caller.memberId });
          return json(200, { revoked: true });
        }
        if (typeof body.token !== "string" || !tokenPattern.test(body.token)) return json(400, { error: "invalid_request" });
        const client = await deps.store.client(body.client_id);
        if (!client || client.status === "offboarded") return unavailable();
        const plan = await deps.store.plan(body.client_id);
        const mapping = plan?.billing_package_price_id ? await deps.store.packagePrice(plan.billing_package_price_id) : null;
        const live = await deps.store.billingLivemode();
        const price = mapping ? await deps.store.priceMirror(mapping.stripe_price_id) : null;
        const bad = checkCheckoutPrice({ plan, mapping, price, clientId: body.client_id, livemode: live });
        if (bad) return json(bad.status, { error: bad.code, detail: bad.message });
        const customer = await deps.store.activeLink(body.client_id, live);
        if (!customer) return json(409, { error: "no_customer", detail: "Link a Stripe customer first." });
        if ((await deps.store.blockingSubscriptions(body.client_id, live)).length) return json(409, { error: "subscription_exists", detail: "This client already has a subscription." });
        const link = await deps.links.write({ op: "issue", client_id: body.client_id, actor_id: caller.memberId,
          token_hash: tokenHash(body.token), agreement: plan, customer_id: customer.stripe_customer_id });
        return json(200, { ...link, url: `${deps.appUrl}/pay/${body.token}` });
      }
      if (body.action !== "read" && body.action !== "open") return json(400, { error: "invalid_request" });
      if (typeof body.token !== "string" || !tokenPattern.test(body.token)) return unavailable();
      const hash = tokenHash(body.token);
      const link = await deps.links.read(hash);
      if (!link) return unavailable();
      if (body.action === "read") return json(200, { client_name: link.client_name, agreement: {
        agreed_amount_cents: link.agreement.agreed_amount_cents, agreed_currency: link.agreement.agreed_currency,
        agreed_billing_interval: link.agreement.agreed_billing_interval, agreed_billing_interval_count: link.agreement.agreed_billing_interval_count,
      },
        expires_at: link.expires_at, state: link.state, livemode: link.livemode });
      if (link.state === "complete") return json(409, { error: "complete", detail: "Payment setup was submitted. Contact Compass if you need help." });
      const lease = randomUUID();
      const claim = await deps.links.write({ op: "claim", token_hash: hash, lease_id: lease });
      if (!claim) return unavailable();
      if (claim.busy) return json(409, { error: "busy", detail: "Payment setup is opening. Please try again in a moment." });
      let session: string | undefined;
      try {
        const result = await deps.checkout(claim as PaymentLink);
        const checkout = result.checkout as { session_id?: string; url?: string; status?: string } | undefined;
        if (!checkout?.url || checkout.status !== "open" || !/^https:\/\/checkout\.stripe\.com\//.test(checkout.url)) return unavailable();
        session = checkout.session_id;
        return json(200, { url: checkout.url });
      } finally {
        await deps.links.write({ op: "release", id: claim.id, lease_id: lease, ...(session ? { session_id: session } : {}) });
      }
    } catch (error) {
      const e = error as { code?: string; status?: number };
      if (e.code === "55P03") return json(409, { error: "busy", detail: "Payment setup is in progress. Try again shortly." });
      if (e.code === "subscription_exists") return json(409, { error: "complete", detail: "Payment setup already exists or is processing. Please contact Compass if you need help." });
      // Never expose Stripe customer ids, subscriptions or database errors publicly.
      return json(e.status && e.status < 500 ? e.status : 503, { error: "unavailable", detail: "Payment setup is unavailable. Please try again shortly or contact Compass." });
    }
  };
}
