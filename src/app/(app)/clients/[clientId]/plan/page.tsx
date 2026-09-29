import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { enrollPipelineAction, unenrollPipelineAction } from "@/app/actions";
import {
  clearEntitlementOverrideAction,
  saveAgreementAction,
  setEntitlementOverrideAction,
} from "@/app/agreement-actions";
import {
  attentionLabel,
  billingState,
  billingStateLabels,
  billingStateStyles,
  entitlementText,
  externalMethodLabels,
  formatMoney,
  type Entitlement,
} from "@/lib/billing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { BlockedBanner } from "@/components/blocked-banner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const selectClass = "field w-full";

function centsInput(cents: number | null | undefined): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

function fmtDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default async function PlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ blocked?: string; hint?: string; error?: string }>;
}) {
  const { clientId } = await params;
  const { blocked, hint, error } = await searchParams;
  const supabase = await createClient();
  const [
    { data: plan },
    { data: pipelines },
    { data: enrollments },
    { data: packages },
    { data: status },
    { data: entitlementRows },
  ] = await Promise.all([
    supabase.from("plans").select("*").eq("client_id", clientId).maybeSingle(),
    supabase
      .from("pipelines")
      .select("*")
      .eq("is_recurring", false)
      .order("sort_order"),
    supabase
      .from("client_pipelines")
      .select("*, pipelines(name, is_recurring)")
      .eq("client_id", clientId),
    supabase
      .from("billing_packages")
      .select("id, name, kind, active")
      .order("sort_order")
      .order("name"),
    supabase
      .from("client_billing_status")
      .select("billing_state, attention_reasons, mrr_cents, currency, next_billing_at, livemode")
      .eq("client_id", clientId)
      .maybeSingle(),
    supabase
      .from("client_entitlements")
      .select("*")
      .eq("client_id", clientId)
      .order("sort_order"),
  ]);

  const saveAgreement = saveAgreementAction.bind(null, clientId);
  const enrolledByPipeline = new Map(
    (enrollments ?? []).map((e) => [e.pipeline_id, e])
  );
  const entitlements = (entitlementRows ?? []) as Entitlement[];
  const state = billingState(status?.billing_state);
  const reasons = status?.attention_reasons ?? [];
  const choosable = (packages ?? []).filter((p) => p.active || p.id === plan?.package_id);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {error && (
        <div className="lg:col-span-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agreement</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={saveAgreement} className="grid grid-cols-2 gap-3">
            <div className="space-y-1 col-span-2">
              <Label htmlFor="package_id">Package</Label>
              <select id="package_id" name="package_id" defaultValue={plan?.package_id ?? ""} className={selectClass}>
                <option value="">No package yet</option>
                {choosable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.kind === "custom" ? " (custom retainer)" : ""}
                    {p.active ? "" : " (retired)"}
                  </option>
                ))}
              </select>
              {(packages ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No packages in the catalog yet. The price comes from Stripe;
                  the package says what the client receives.
                </p>
              )}
            </div>
            <div className="space-y-1 col-span-2">
              <Label htmlFor="collection">Payment</Label>
              <select id="collection" name="collection" defaultValue={plan?.collection ?? "stripe"} className={selectClass}>
                <option value="stripe">Stripe (card or ACH debit, collected automatically)</option>
                <option value="external">Paid externally (check, wire, manual ACH)</option>
              </select>
            </div>
            <fieldset className="col-span-2 grid grid-cols-3 gap-3 rounded-md border px-3 pb-3 pt-1">
              <legend className="px-1 text-xs text-muted-foreground">Only for an externally paid arrangement</legend>
              <div className="space-y-1">
                <Label htmlFor="external_method">Method</Label>
                <select id="external_method" name="external_method" defaultValue={plan?.external_method ?? ""} className={selectClass}>
                  <option value="">—</option>
                  {Object.entries(externalMethodLabels).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="external_amount">Amount</Label>
                <Input id="external_amount" name="external_amount" inputMode="decimal" defaultValue={centsInput(plan?.external_amount_cents)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="external_interval">Per</Label>
                <select id="external_interval" name="external_interval" defaultValue={plan?.external_interval ?? "month"} className={selectClass}>
                  <option value="month">month</option>
                  <option value="year">year</option>
                </select>
              </div>
              <input type="hidden" name="external_currency" value={plan?.external_currency ?? "usd"} />
            </fieldset>
            <div className="space-y-1">
              <Label htmlFor="term_months">Term (months)</Label>
              <Input id="term_months" name="term_months" type="number" min={1} defaultValue={plan?.term_months ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="managed_ad_budget">Ad budget managed ($ / month)</Label>
              <Input id="managed_ad_budget" name="managed_ad_budget" inputMode="decimal" defaultValue={centsInput(plan?.managed_ad_budget_cents)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="start_date">Start date</Label>
              <Input id="start_date" name="start_date" type="date" defaultValue={plan?.start_date ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="renewal_date">Renewal date</Label>
              <Input id="renewal_date" name="renewal_date" type="date" defaultValue={plan?.renewal_date ?? ""} />
            </div>
            <div className="space-y-1 col-span-2">
              <Label htmlFor="notes">Agreement notes</Label>
              <Textarea id="notes" name="notes" defaultValue={plan?.notes ?? ""} rows={3} />
            </div>
            <div className="col-span-2">
              <Button type="submit">Save agreement</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Enrolled pipelines</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <BlockedBanner message={blocked} hint={hint} />
          <p className="text-xs text-muted-foreground">
            Enrolling creates the pipeline&apos;s stages and its playbook tasks.
            Removing an enrollment deletes its stage progress. Foundation runs
            for every client and cannot be removed.
          </p>
          <p className="text-xs text-muted-foreground">
            A <span className="font-medium">pending</span> pipeline is enrolled
            but waiting on Foundation — it reads the taxonomy, brand board and
            keyword map. It starts itself, and creates its tasks, the moment
            Foundation completes.
          </p>
          {(pipelines ?? []).map((p) => {
            const enrollment = enrolledByPipeline.get(p.id);
            const enroll = enrollPipelineAction.bind(null, clientId, p.id);
            const unenroll = enrollment
              ? unenrollPipelineAction.bind(null, clientId, enrollment.id)
              : null;
            return (
              <div
                key={p.id}
                className="flex items-center justify-between border rounded-md px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{p.name}</span>
                  {enrollment && (
                    <Badge
                      variant="outline"
                      className={
                        enrollment.status === "complete"
                          ? "bg-green-100 text-green-800 border-green-200"
                          : enrollment.status === "pending"
                            ? "bg-amber-100 text-amber-800 border-amber-200"
                            : "bg-blue-100 text-blue-800 border-blue-200"
                      }
                    >
                      {enrollment.status}
                    </Badge>
                  )}
                </div>
                {enrollment ? (
                  p.key === "foundation" ? (
                    <span className="text-xs text-muted-foreground">
                      Always enrolled
                    </span>
                  ) : (
                    <form action={unenroll!}>
                      <Button variant="outline" size="sm" type="submit">
                        Remove
                      </Button>
                    </form>
                  )
                ) : (
                  <form action={enroll}>
                    <Button size="sm" type="submit">
                      Enroll
                    </Button>
                  </form>
                )}
              </div>
            );
          })}
          {(enrollments ?? []).some((e) => e.pipelines?.is_recurring) && (
            <div className="border rounded-md px-3 py-2 flex items-center justify-between bg-muted/40">
              <span className="font-medium text-sm">Reporting (recurring)</span>
              <Badge variant="outline" className="bg-green-100 text-green-800 border-green-200">
                enrolled
              </Badge>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">What the agreement includes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            The package sets the defaults; an override records exactly what
            this client receives instead, with the reason. Billing state is
            shown alongside and never switches a service off.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Service</TableHead>
                <TableHead>Package</TableHead>
                <TableHead>This client</TableHead>
                <TableHead className="w-[40%]">Override</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entitlements.map((e) => {
                const setOverride = setEntitlementOverrideAction.bind(null, clientId, e.service_key);
                const clearOverride = clearEntitlementOverrideAction.bind(null, clientId, e.service_key);
                return (
                  <TableRow key={e.service_key}>
                    <TableCell className="font-medium">{e.service_name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {e.package_enabled == null
                        ? "—"
                        : entitlementText({ ...e, enabled: e.package_enabled, quantity: e.package_quantity })}
                    </TableCell>
                    <TableCell>
                      <span className={e.enabled ? "" : "text-muted-foreground"}>{entitlementText(e)}</span>
                      {e.source === "override" && (
                        <span className="block text-xs text-muted-foreground">Override: {e.override_reason}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          {e.source === "override" ? "Change override" : "Override"}
                        </summary>
                        <form action={setOverride} className="mt-2 flex flex-wrap items-end gap-2">
                          <label className="flex items-center gap-1 text-xs">
                            <input type="checkbox" name="enabled" defaultChecked={e.enabled} /> Included
                          </label>
                          {e.service_kind === "quota" && (
                            <Input name="quantity" type="number" min={0} className="w-20" defaultValue={e.quantity ?? ""} aria-label="Quantity" />
                          )}
                          <Input name="reason" placeholder="Why (required)" className="min-w-40 flex-1" defaultValue={e.override_reason ?? ""} />
                          <Button size="sm" type="submit">Save</Button>
                        </form>
                        {e.source === "override" && (
                          <form action={clearOverride} className="mt-1">
                            <Button size="sm" variant="outline" type="submit">Use the package</Button>
                          </form>
                        )}
                      </details>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Billing</CardTitle>
            <Badge variant="outline" className={billingStateStyles[state]}>
              {billingStateLabels[state]}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {state === "external" ? (
            <p className="text-muted-foreground">
              Paid externally
              {plan?.external_method ? ` by ${externalMethodLabels[plan.external_method]?.toLowerCase()}` : ""}
              {plan?.external_amount_cents
                ? `: ${formatMoney(plan.external_amount_cents, plan.external_currency)} / ${plan.external_interval}`
                : ""}
              . Stripe is not collecting for this client.
            </p>
          ) : (
            <p className="text-muted-foreground">
              {status?.mrr_cents != null ? `${formatMoney(status.mrr_cents, status.currency)} / month` : "No recurring charge"}
              {status?.next_billing_at ? ` · next billing ${fmtDate(status.next_billing_at)}` : ""}
              {status?.livemode === false ? " · Stripe test mode" : ""}
            </p>
          )}
          {reasons.length > 0 && (
            <ul className="list-disc pl-5 text-red-800">
              {reasons.map((r) => <li key={r}>{attentionLabel(r)}</li>)}
            </ul>
          )}
          <p className="text-muted-foreground">
            Prices, invoices and payments come from Stripe; see the{" "}
            <Link href={`/clients/${clientId}/billing`} className="underline">
              Billing tab
            </Link>
            . Checkout links and the Stripe customer portal arrive with the
            next billing release.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
