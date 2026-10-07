import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTeamRole } from "@/lib/team";
import { agreementStaff, agreementMailReady } from "@/lib/agreements-server";
import { agreementStatus, type Contract } from "@/lib/agreements";
import {
  saveContractAction,
  voidContractAction,
  attachContractPaymentAction,
} from "@/app/contract-actions";
import { AgreementDocument } from "@/components/agreements/agreement-document";
import { IssueAgreement } from "@/components/agreements/issue-agreement";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default async function AgreementPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string; agreementId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { clientId, agreementId } = await params;
  const feedback = await searchParams;
  const supabase = await createClient();
  const me = await getCurrentTeamRole(supabase);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!me || !user) return null;
  let c: Contract;
  try {
    c = await agreementStaff<Contract>(user.id, "read", { id: agreementId });
  } catch {
    notFound();
  }
  if (c.client_id !== clientId) notFound();
  const admin = me.role === "admin";
  const state = agreementStatus(c);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href={`/clients/${clientId}/agreements`}
          className="text-sm text-blue-700"
        >
          Back to agreements
        </Link>
        <span className="rounded-full bg-blue-50 px-3 py-1 text-sm capitalize text-blue-900">
          {state}
        </span>
      </div>
      {feedback.error && (
        <p
          role="alert"
          className="rounded-lg bg-red-50 p-4 text-sm text-red-800"
        >
          {feedback.error}
        </p>
      )}
      {feedback.notice && (
        <p
          role="status"
          className="rounded-lg bg-green-50 p-4 text-sm text-green-900"
        >
          {feedback.notice}
        </p>
      )}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <AgreementDocument contract={c} />
        <div className="space-y-5">
          {c.status === "draft" && admin && (
            <Card>
              <CardHeader>
                <CardTitle>Edit draft</CardTitle>
              </CardHeader>
              <CardContent>
                <form
                  action={saveContractAction.bind(null, clientId, c.id)}
                  className="space-y-4"
                >
                  <label className="block text-sm">
                    Agreement title
                    <Input
                      name="title"
                      defaultValue={c.title}
                      required
                      maxLength={180}
                    />
                  </label>
                  <label className="block text-sm">
                    Recipient full name
                    <Input
                      name="recipient_name"
                      defaultValue={c.recipient_name}
                      required
                      minLength={2}
                      maxLength={160}
                      autoComplete="name"
                    />
                  </label>
                  <label className="block text-sm">
                    Recipient email
                    <Input
                      name="recipient_email"
                      type="email"
                      defaultValue={c.recipient_email}
                      required
                      maxLength={254}
                      autoComplete="email"
                    />
                  </label>
                  <label className="block text-sm">
                    Complete contract terms
                    <textarea
                      name="terms"
                      defaultValue={c.snapshot.terms}
                      required
                      minLength={50}
                      maxLength={60000}
                      rows={14}
                      className="mt-2 w-full rounded border p-2 text-sm"
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Saving refreshes the fee and services from the current plan.
                    Review the preview after saving.
                  </p>
                  <Button type="submit" loadingLabel="Saving draft…">
                    Save draft
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}
          {admin && (state === "draft" || state === "issued") && (
            <Card>
              <CardHeader>
                <CardTitle>
                  {state === "draft" ? "Review and issue" : "Signing link"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-4 text-sm text-muted-foreground">
                  The recipient verifies their email before reviewing and
                  signing. Issuing locks these terms. No payment is created.
                </p>
                {!agreementMailReady() && (
                  <p className="mb-4 text-sm text-amber-800">
                    Verification email setup is required.
                  </p>
                )}
                <IssueAgreement
                  clientId={clientId}
                  id={c.id}
                  providerName={me.name}
                  issued={state === "issued"}
                  ready={
                    agreementMailReady() &&
                    !!c.recipient_email &&
                    c.snapshot.terms.length >= 50
                  }
                />
              </CardContent>
            </Card>
          )}
          {c.status === "signed" && (
            <Card>
              <CardHeader>
                <CardTitle>Signed agreement</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm">
                  Signed by {c.signer_name}. The final document and signatures
                  are locked.
                </p>
                <a
                  href={`/agreements/${c.id}/pdf`}
                  className={buttonVariants({ variant: "outline" })}
                >
                  Download signed PDF
                </a>
                <Link
                  href={`/clients/${clientId}/billing`}
                  className={buttonVariants()}
                >
                  Open billing setup
                </Link>
                {admin && (
                  <form
                    action={attachContractPaymentAction.bind(
                      null,
                      clientId,
                      c.id,
                    )}
                  >
                    <Button
                      type="submit"
                      variant="outline"
                      loadingLabel="Attaching payment link…"
                    >
                      Attach live payment link
                    </Button>
                  </form>
                )}
                <p className="text-xs text-muted-foreground">
                  Create the exact approved price and payment link in Billing
                  first. Attaching it requires live mode and the signed scope to
                  match the plan.
                </p>
                {c.payment_url && (
                  <p className="text-sm text-green-800">
                    Payment link attached to the recipient’s agreement page.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
          {admin && ["draft", "issued"].includes(c.status) && (
            <form action={voidContractAction.bind(null, clientId, c.id)}>
              <Button
                type="submit"
                variant="outline"
                loadingLabel="Voiding agreement…"
              >
                Void this agreement and its link
              </Button>
            </form>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Agreement history</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-4 text-sm">
                {c.events?.map((e) => (
                  <li key={e.id}>
                    <p className="font-medium capitalize">
                      {e.kind.replaceAll("_", " ")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {e.actor} ·{" "}
                      {new Date(e.created_at).toLocaleString("en-US", {
                        timeZone: "America/Chicago",
                      })}
                    </p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
