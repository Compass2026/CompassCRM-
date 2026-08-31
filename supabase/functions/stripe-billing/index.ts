// Stripe billing actions — called from the app's server actions by a
// signed-in team member (JWT-authorized, same pattern as brightlocal-sync).
// Reads STRIPE_SECRET_KEY from Vault; the app itself never sees it.
//
// Actions (POST { action, client_id }):
//   setup   -> create the Stripe customer (if missing) and a monthly
//              subscription priced from plans.monthly_fee. The subscription
//              is created payment_behavior: default_incomplete and accepts
//              card or ACH debit; the first hosted invoice link is stored on
//              the subscriptions row so it can be sent to the client. Once
//              they pay, the payment method is saved on the subscription and
//              future cycles charge automatically (status via webhooks).
//   pause   -> pause_collection (invoices are drafted but not charged)
//   resume  -> clear pause_collection

import Stripe from "npm:stripe@18";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const jwt = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
  const { data: userData } = await supabase.auth.getUser(jwt);
  if (!userData?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data: apiKey } = await supabase.rpc("get_secret", {
    secret_name: "STRIPE_SECRET_KEY",
  });
  if (!apiKey) {
    return Response.json(
      { error: "STRIPE_SECRET_KEY not configured" },
      { status: 500 }
    );
  }
  const stripe = new Stripe(apiKey, {
    httpClient: Stripe.createFetchHttpClient(),
  });

  const body = await req.json().catch(() => ({}));
  const action: string = body.action ?? "";
  const clientId: string | null = body.client_id ?? null;
  if (!clientId) {
    return Response.json({ error: "client_id required" }, { status: 400 });
  }

  try {
    switch (action) {
      case "setup": {
        const [{ data: client }, { data: plan }, { data: contact }] =
          await Promise.all([
            supabase
              .from("clients")
              .select("id, name")
              .eq("id", clientId)
              .single(),
            supabase
              .from("plans")
              .select("package_name, monthly_fee")
              .eq("client_id", clientId)
              .maybeSingle(),
            supabase
              .from("client_contacts")
              .select("name, email")
              .eq("client_id", clientId)
              .eq("is_primary", true)
              .maybeSingle(),
          ]);
        if (!client) {
          return Response.json({ error: "client not found" }, { status: 404 });
        }
        if (!plan?.monthly_fee || plan.monthly_fee <= 0) {
          return Response.json(
            { error: "Set a monthly fee on the Plan tab first" },
            { status: 400 }
          );
        }

        // Customer: reuse if this client already has one.
        const { data: existingCustomer } = await supabase
          .from("stripe_customers")
          .select("stripe_customer_id")
          .eq("client_id", clientId)
          .maybeSingle();
        let customerId = existingCustomer?.stripe_customer_id;
        if (!customerId) {
          const customer = await stripe.customers.create({
            name: client.name,
            email: contact?.email ?? undefined,
            metadata: { compass_client_id: clientId },
          });
          customerId = customer.id;
          await supabase
            .from("stripe_customers")
            .insert({ client_id: clientId, stripe_customer_id: customerId });
        }

        // One active subscription per client.
        const { data: existingSub } = await supabase
          .from("subscriptions")
          .select("id, status")
          .eq("client_id", clientId)
          .not("status", "in", "(canceled)")
          .maybeSingle();
        if (existingSub) {
          return Response.json(
            { error: "Client already has a subscription" },
            { status: 400 }
          );
        }

        const product = await stripe.products.create({
          name: `${client.name} — ${plan.package_name ?? "Compass plan"}`,
          metadata: { compass_client_id: clientId },
        });
        const subscription = await stripe.subscriptions.create({
          customer: customerId,
          items: [
            {
              price_data: {
                currency: "usd",
                product: product.id,
                unit_amount: Math.round(plan.monthly_fee * 100),
                recurring: { interval: "month" },
              },
            },
          ],
          collection_method: "charge_automatically",
          payment_behavior: "default_incomplete",
          payment_settings: {
            payment_method_types: ["card", "us_bank_account"],
            save_default_payment_method: "on_subscription",
          },
          metadata: { compass_client_id: clientId },
          expand: ["latest_invoice"],
        });

        const item = subscription.items?.data?.[0];
        const legacy = subscription as unknown as {
          current_period_start?: number;
          current_period_end?: number;
        };
        const periodStart =
          legacy.current_period_start ??
          (item as unknown as { current_period_start?: number })
            ?.current_period_start;
        const periodEnd =
          legacy.current_period_end ??
          (item as unknown as { current_period_end?: number })
            ?.current_period_end;
        const invoice = subscription.latest_invoice as Stripe.Invoice | null;

        await supabase.from("subscriptions").insert({
          client_id: clientId,
          stripe_subscription_id: subscription.id,
          stripe_price_id: item?.price?.id ?? null,
          amount: plan.monthly_fee,
          interval: "month",
          status: subscription.status,
          current_period_start: periodStart
            ? new Date(periodStart * 1000).toISOString()
            : null,
          current_period_end: periodEnd
            ? new Date(periodEnd * 1000).toISOString()
            : null,
          paid_status: "open",
          latest_invoice_url: invoice?.hosted_invoice_url ?? null,
        });

        return Response.json({
          ok: true,
          customer_id: customerId,
          subscription_id: subscription.id,
          invoice_url: invoice?.hosted_invoice_url ?? null,
        });
      }

      case "pause":
      case "resume": {
        const { data: sub } = await supabase
          .from("subscriptions")
          .select("id, stripe_subscription_id")
          .eq("client_id", clientId)
          .not("stripe_subscription_id", "is", null)
          .maybeSingle();
        if (!sub?.stripe_subscription_id) {
          return Response.json({ error: "no subscription" }, { status: 404 });
        }
        const updated = await stripe.subscriptions.update(
          sub.stripe_subscription_id,
          action === "pause"
            ? { pause_collection: { behavior: "keep_as_draft" } }
            : { pause_collection: "" }
        );
        await supabase
          .from("subscriptions")
          .update({ status: action === "pause" ? "paused" : updated.status })
          .eq("id", sub.id);
        return Response.json({ ok: true, status: updated.status });
      }

      default:
        return Response.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: 500 });
  }
});
