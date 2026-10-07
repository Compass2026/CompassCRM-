import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTeamRole } from "@/lib/team";
import { agreementStaff, agreementMailReady } from "@/lib/agreements-server";
import {
  agreementPrice,
  agreementStatus,
  type Contract,
} from "@/lib/agreements";
import {
  createContractAction,
  saveContractTemplateAction,
} from "@/app/contract-actions";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default async function AgreementsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { clientId } = await params;
  const feedback = await searchParams;
  const supabase = await createClient();
  const me = await getCurrentTeamRole(supabase);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!me || !user) return null;
  type Listing = {
    issuer: { name: string; terms: string; terms_reviewed: boolean };
    contracts: Contract[];
  };
  let listing: Listing | undefined;
  let failure: string | undefined;
  try {
    listing = await agreementStaff<Listing>(user.id, "list", {
      client_id: clientId,
    });
  } catch {
    failure = "Agreement storage is not available yet.";
  }
  const admin = me.role === "admin";
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Agreements</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Review the contract, collect a verified signature, and keep the
            final record with this client.
          </p>
        </div>
        {admin && listing && (
          <form action={createContractAction.bind(null, clientId)}>
            <Button type="submit" loadingLabel="Creating draft…">
              Create agreement
            </Button>
          </form>
        )}
      </div>
      {(feedback.error || failure) && (
        <p
          role="alert"
          className="rounded-lg bg-red-50 p-4 text-sm text-red-800"
        >
          {feedback.error || failure}
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
      {!agreementMailReady() && (
        <p className="rounded-lg border bg-amber-50 p-4 text-sm text-amber-900">
          Drafting is available. Verification email must be configured before
          signing links can be issued.
        </p>
      )}
      <div className="grid gap-4">
        {listing?.contracts.map((c) => (
          <Link
            key={c.id}
            href={`/clients/${clientId}/agreements/${c.id}`}
            className="rounded-xl border bg-card p-5 transition-colors hover:bg-muted"
          >
            <div className="flex flex-wrap justify-between gap-3">
              <strong>{c.title}</strong>
              <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold capitalize text-blue-900">
                {agreementStatus(c)}
              </span>
            </div>
            <p className="mt-2 text-sm">
              {agreementPrice(c.snapshot.scope)} ·{" "}
              {c.recipient_name || "Recipient needed"}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Created{" "}
              {new Date(c.created_at).toLocaleDateString("en-US", {
                timeZone: "America/Chicago",
              })}
              {c.signed_at ? " · Signed copy available" : ""}
            </p>
          </Link>
        ))}
      </div>
      {listing?.contracts.length === 0 && (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          Create the first draft from the client’s recorded plan.
        </div>
      )}
      {admin && listing && (
        <Card>
          <CardHeader>
            <CardTitle>Compass contract template</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-muted-foreground">
              Paste the complete terms from your current contract. New drafts
              use this text. Existing drafts and signed agreements keep their
              own copies.
            </p>
            <form
              action={saveContractTemplateAction.bind(null, clientId)}
              className="space-y-4"
            >
              <label className="block text-sm font-medium">
                Contract terms
                <textarea
                  name="terms"
                  required
                  minLength={50}
                  maxLength={60000}
                  rows={12}
                  defaultValue={listing.issuer.terms}
                  className="mt-2 w-full rounded-lg border bg-background p-3 text-sm"
                />
              </label>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  name="reviewed"
                  defaultChecked={listing.issuer.terms_reviewed}
                  className="mt-1"
                />
                These are Compass’s reviewed contract terms.
              </label>
              <Button type="submit" loadingLabel="Saving template…">
                Save template
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
