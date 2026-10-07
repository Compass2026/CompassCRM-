import { cookies } from "next/headers";
import { agreementSigner } from "@/lib/agreements-server";
import { activeAgreementPayment, type Contract } from "@/lib/agreements";
import { AgreementDocument } from "@/components/agreements/agreement-document";
import { SignAgreement } from "@/components/agreements/sign-agreement";
import { buttonVariants } from "@/components/ui/button";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "Review agreement | Compass",
  robots: { index: false, follow: false },
};

export default async function SigningPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = (await cookies()).get("agreement_session")?.value;
  type Answer = Partial<Contract> & {
    error?: string;
    verified?: boolean;
    issuer?: string;
  };
  let result: Answer;
  try {
    result = await agreementSigner<Answer>(token, session, "read");
  } catch {
    result = { error: "temporarily_unavailable" };
  }
  if (result.error)
    return (
      <main className="mx-auto max-w-xl p-8">
        <h1 className="text-2xl font-semibold">Agreement unavailable</h1>
        <p className="mt-4 text-sm text-muted-foreground">
          {result.error === "temporarily_unavailable"
            ? "Please try again shortly or contact the sender."
            : "This link is unavailable or expired. Contact the sender for a new link."}
        </p>
      </main>
    );
  const c = result.verified ? (result as Contract) : null;
  const payment = c ? activeAgreementPayment(c) : null;
  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <header>
        <p className="text-sm font-semibold text-blue-800">
          Compass Agreements
        </p>
        <h1 className="mt-2 text-2xl font-semibold">
          {c?.status === "signed"
            ? "Your signed agreement"
            : c
              ? "Review your agreement"
              : `Agreement from ${result.issuer}`}
        </h1>
      </header>
      {c && <AgreementDocument contract={c} />}
      {!c || c.status === "issued" ? (
        <SignAgreement
          token={token}
          verified={!!c}
          contentHash={c?.content_hash}
          recipientName={c?.recipient_name}
        />
      ) : c.status === "signed" ? (
        <section className="space-y-4 rounded-xl border bg-white p-6">
          <p role="status" className="font-medium text-green-800">
            Your signature is saved. Download and keep your copy.
          </p>
          <a
            href={`/sign/${token}/pdf`}
            className={buttonVariants({ variant: "outline" })}
          >
            Download signed PDF
          </a>
          {payment ? (
            <div className="space-y-3 border-t pt-4">
              <h2 className="font-semibold">Set up payment</h2>
              <p className="text-sm text-muted-foreground">
                Stripe will show the amount and collect your payment
                authorization separately.
              </p>
              <a href={payment} rel="noreferrer" className={buttonVariants()}>
                Continue to secure payment
              </a>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              The sender will provide payment setup separately. Signing this
              agreement did not authorize a payment.
            </p>
          )}
        </section>
      ) : (
        <p className="rounded-xl border p-6">
          This agreement was declined. Contact the sender to discuss changes.
        </p>
      )}
    </main>
  );
}
