import { paymentLinkCall } from "@/lib/payment-links";
import { PaymentContinue } from "@/components/billing/payment-continue";
import { formatMoney } from "@/lib/billing";
export const dynamic = "force-dynamic";
export const metadata = { title: "Payment setup | Compass Marketing", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function PaymentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = /^[A-Za-z0-9_-]{43}$/.test(token) ? await paymentLinkCall({ action: "read", token }) : { error: "unavailable" };
  const agreement = result.agreement;
  return <main className="mx-auto max-w-xl space-y-6 px-6 py-12">
    <header><p className="text-sm font-semibold text-blue-800">Compass Marketing Advisors</p><h1 className="mt-3 text-3xl font-semibold tracking-tight">Set up your payment</h1></header>
    {result.error || !agreement ? <p className="rounded-xl border p-6">{result.detail ?? "This payment link is unavailable or expired. Contact Compass for a new link."}</p>
      : <section className="space-y-5 rounded-xl border bg-white p-6 shadow-sm">
        <p className="font-medium">{result.client_name}</p>
        {!result.livemode && <p className="text-sm text-amber-800">Test payment setup. No real payment.</p>}
        <p className="text-3xl font-semibold">{formatMoney(agreement.agreed_amount_cents, agreement.agreed_currency)}<span className="ml-2 text-base font-normal text-muted-foreground">{agreement.agreed_billing_interval_count === 1 ? `per ${agreement.agreed_billing_interval}` : `every ${agreement.agreed_billing_interval_count} ${agreement.agreed_billing_interval}s`}</span></p>
        {result.state === "complete" ? <p role="status">Payment setup was submitted. Contact Compass if you need help. Bank payments may take a few business days to clear.</p> : <>
          <p className="text-sm text-muted-foreground">Continue to Stripe to choose card or bank payment and authorize your recurring subscription. Your subscription begins when you complete payment setup, subject to bank processing.</p>
          <PaymentContinue token={token} />
          <p className="text-xs text-muted-foreground">This Compass link is valid until {new Date(result.expires_at!).toLocaleDateString("en-US", { timeZone: "America/Chicago", dateStyle: "long" })}. If your Stripe page expires, return here to continue.</p>
        </>}
      </section>}
  </main>;
}
