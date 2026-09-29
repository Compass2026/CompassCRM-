// stripe-billing — retired with the 0008 design (per-client Stripe products,
// hosted-invoice setup, pause / resume writing paid_status). Its replacement
// arrives in B3 (Checkout, linking an existing Stripe customer, the Customer
// Portal) on the shared sync layer; see docs/billing.md. Until then every
// request is refused, so nothing can create Stripe objects against the new
// schema. The deployed v2 is the old code: do not add Stripe secrets or
// redeploy it before B3 (docs/billing-cutover.md).
Deno.serve(() =>
  new Response(JSON.stringify({ error: "stripe_billing_replaced", detail: "Billing actions return in B3 (docs/billing.md)." }), {
    status: 410,
    headers: { "content-type": "application/json" },
  })
);
