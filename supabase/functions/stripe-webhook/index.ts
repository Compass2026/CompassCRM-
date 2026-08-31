// Stripe webhook — the single writer for paid status (spec §6.5b).
//
// Deployed with verify_jwt = false: Stripe cannot send a Supabase JWT, so
// authenticity comes from the webhook signature instead, verified against
// STRIPE_WEBHOOK_SECRET from Vault. Handles:
//
//   invoice.paid                    -> payment row + paid_status 'paid'
//   invoice.payment_failed          -> paid_status 'past_due' + pay link
//   payment_intent.processing       -> paid_status 'processing' (ACH in flight)
//   customer.subscription.updated   -> mirror status / price / period;
//                                      new period resets paid_status to 'open'
//   customer.subscription.deleted   -> status 'canceled'
//
// Every event id is recorded in stripe_events first, so Stripe's retries
// are acknowledged without double-writing payments.

import Stripe from "npm:stripe@18";
import { createClient } from "npm:@supabase/supabase-js@2";

const cryptoProvider = Stripe.createSubtleCryptoProvider();

// Period fields moved from the subscription onto its items in newer Stripe
// API versions; read both so the handler survives an account API upgrade.
function subscriptionPeriod(sub: Stripe.Subscription): {
  start: string | null;
  end: string | null;
} {
  const legacy = sub as unknown as {
    current_period_start?: number;
    current_period_end?: number;
  };
  const item = sub.items?.data?.[0] as unknown as
    | { current_period_start?: number; current_period_end?: number }
    | undefined;
  const start = legacy.current_period_start ?? item?.current_period_start;
  const end = legacy.current_period_end ?? item?.current_period_end;
  return {
    start: start ? new Date(start * 1000).toISOString() : null,
    end: end ? new Date(end * 1000).toISOString() : null,
  };
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const legacy = invoice as unknown as { subscription?: string | { id: string } };
  if (legacy.subscription) {
    return typeof legacy.subscription === "string"
      ? legacy.subscription
      : legacy.subscription.id;
  }
  const parent = invoice as unknown as {
    parent?: { subscription_details?: { subscription?: string | { id: string } } };
  };
  const sub = parent.parent?.subscription_details?.subscription;
  return typeof sub === "string" ? sub : (sub?.id ?? null);
}

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const [{ data: webhookSecret }, { data: apiKey }] = await Promise.all([
    supabase.rpc("get_secret", { secret_name: "STRIPE_WEBHOOK_SECRET" }),
    supabase.rpc("get_secret", { secret_name: "STRIPE_SECRET_KEY" }),
  ]);
  if (!webhookSecret || !apiKey) {
    return Response.json({ error: "Stripe secrets not configured" }, { status: 500 });
  }
  const stripe = new Stripe(apiKey, {
    httpClient: Stripe.createFetchHttpClient(),
  });

  const signature = req.headers.get("stripe-signature");
  const payload = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      payload,
      signature ?? "",
      webhookSecret,
      undefined,
      cryptoProvider
    );
  } catch {
    return Response.json({ error: "invalid signature" }, { status: 400 });
  }

  // Idempotency: first delivery wins, retries are acknowledged as-is.
  const { error: eventError } = await supabase
    .from("stripe_events")
    .insert({ id: event.id, type: event.type });
  if (eventError) {
    return Response.json({ ok: true, duplicate: true });
  }

  async function clientIdForCustomer(customerId: string): Promise<string | null> {
    const { data } = await supabase
      .from("stripe_customers")
      .select("client_id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();
    return data?.client_id ?? null;
  }

  // Mirror the subscription's default payment method onto stripe_customers
  // (type + last4) — set by Stripe when the first invoice is paid, thanks to
  // save_default_payment_method: on_subscription.
  async function syncPaymentMethod(
    subscriptionId: string,
    clientId: string
  ): Promise<"card" | "stripe_ach" | null> {
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ["default_payment_method"],
      });
      const pm = sub.default_payment_method;
      if (!pm || typeof pm === "string") return null;
      const type =
        pm.type === "us_bank_account"
          ? ("us_bank_account" as const)
          : pm.type === "card"
            ? ("card" as const)
            : null;
      if (!type) return null;
      await supabase
        .from("stripe_customers")
        .update({
          payment_method_type: type,
          last4: pm.card?.last4 ?? pm.us_bank_account?.last4 ?? null,
        })
        .eq("client_id", clientId);
      return type === "us_bank_account" ? "stripe_ach" : "card";
    } catch {
      return null;
    }
  }

  switch (event.type) {
    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId =
        typeof invoice.customer === "string"
          ? invoice.customer
          : invoice.customer?.id;
      const clientId = customerId ? await clientIdForCustomer(customerId) : null;
      if (!clientId) break;

      const stripeSubId = invoiceSubscriptionId(invoice);
      const { data: subRow } = stripeSubId
        ? await supabase
            .from("subscriptions")
            .select("id")
            .eq("stripe_subscription_id", stripeSubId)
            .maybeSingle()
        : { data: null };

      const method = stripeSubId
        ? await syncPaymentMethod(stripeSubId, clientId)
        : null;

      const line = invoice.lines?.data?.[0];
      const paidAt = invoice.status_transitions?.paid_at;
      await supabase.from("payments").upsert(
        {
          client_id: clientId,
          subscription_id: subRow?.id ?? null,
          source: "stripe",
          stripe_invoice_id: invoice.id,
          stripe_payment_intent_id: null,
          amount: (invoice.amount_paid ?? 0) / 100,
          method,
          period_start: line?.period?.start
            ? new Date(line.period.start * 1000).toISOString().slice(0, 10)
            : null,
          period_end: line?.period?.end
            ? new Date(line.period.end * 1000).toISOString().slice(0, 10)
            : null,
          paid_at: paidAt
            ? new Date(paidAt * 1000).toISOString()
            : new Date().toISOString(),
          recorded_by: "stripe-webhook",
        },
        { onConflict: "stripe_invoice_id" }
      );

      if (subRow) {
        await supabase
          .from("subscriptions")
          .update({ paid_status: "paid", latest_invoice_url: null })
          .eq("id", subRow.id);
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const stripeSubId = invoiceSubscriptionId(invoice);
      if (!stripeSubId) break;
      await supabase
        .from("subscriptions")
        .update({
          paid_status: "past_due",
          latest_invoice_url: invoice.hosted_invoice_url ?? null,
        })
        .eq("stripe_subscription_id", stripeSubId);
      break;
    }

    case "payment_intent.processing": {
      // ACH debits sit here for days. The PI doesn't reliably link back to
      // its invoice across API versions, so mark the customer's unpaid
      // subscription(s) as processing; invoice.paid / payment_failed settle
      // the final state either way.
      const pi = event.data.object as Stripe.PaymentIntent;
      const customerId =
        typeof pi.customer === "string" ? pi.customer : pi.customer?.id;
      const clientId = customerId ? await clientIdForCustomer(customerId) : null;
      if (!clientId) break;
      await supabase
        .from("subscriptions")
        .update({ paid_status: "processing" })
        .eq("client_id", clientId)
        .in("paid_status", ["open", "past_due"]);
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const { data: existing } = await supabase
        .from("subscriptions")
        .select("id, current_period_start, paid_status, client_id")
        .eq("stripe_subscription_id", sub.id)
        .maybeSingle();
      if (!existing) break;

      const period = subscriptionPeriod(sub);
      const item = sub.items?.data?.[0];
      const price = item?.price;

      // A new billing period starts 'open' unless a payment already covers
      // it (invoice.paid can arrive before subscription.updated).
      let paidStatus = existing.paid_status;
      if (
        period.start &&
        existing.current_period_start &&
        new Date(period.start).getTime() !==
          new Date(existing.current_period_start).getTime()
      ) {
        const { data: covering } = await supabase
          .from("payments")
          .select("id")
          .eq("subscription_id", existing.id)
          .gt("period_end", period.start.slice(0, 10))
          .limit(1);
        paidStatus = covering?.length ? "paid" : "open";
      }

      await supabase
        .from("subscriptions")
        .update({
          status: sub.pause_collection ? "paused" : sub.status,
          stripe_price_id: price?.id ?? undefined,
          amount:
            price?.unit_amount != null ? price.unit_amount / 100 : undefined,
          interval: price?.recurring?.interval ?? undefined,
          current_period_start: period.start,
          current_period_end: period.end,
          cancel_at: sub.cancel_at
            ? new Date(sub.cancel_at * 1000).toISOString()
            : null,
          paid_status: paidStatus,
        })
        .eq("id", existing.id);
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await supabase
        .from("subscriptions")
        .update({
          status: "canceled",
          cancel_at: sub.canceled_at
            ? new Date(sub.canceled_at * 1000).toISOString()
            : new Date().toISOString(),
          latest_invoice_url: null,
        })
        .eq("stripe_subscription_id", sub.id);
      break;
    }
  }

  return Response.json({ ok: true });
});
