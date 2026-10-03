"use server";

// Admin-only "Run Billing Reconciliation" (Settings › Billing) and "Reconcile
// This Client" (the client's Billing tab). Both call stripe-reconcile with the
// admin's own JWT: the exact engine the daily schedule runs, not a separate
// sync. The function answers at once and works in the background; the action
// waits a little for the run to finish so the page can say what it found.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTeamRole } from "@/lib/team";
import { callStripeReconcile } from "@/lib/stripe-billing-call";
import { billingAnswerText, isUuid } from "@/lib/billing-ops";
import { resultText } from "@/lib/billing-reconcile";

type Supabase = Awaited<ReturnType<typeof createClient>>;
const WAIT_MS = 20_000;

function back(path: string, kind: "notice" | "error", message: string): never {
  revalidatePath(path);
  redirect(`${path}?${kind}=${encodeURIComponent(message)}`);
}

async function adminOnly(path: string) {
  const supabase = await createClient();
  const me = await getCurrentTeamRole(supabase);
  if (!me) redirect("/login");
  if (me.role !== "admin") back(path, "error", "Only an admin starts a billing reconciliation.");
  return supabase;
}

async function waitForRun(supabase: Supabase, runId: string) {
  const until = Date.now() + WAIT_MS;
  for (;;) {
    const { data } = await supabase
      .from("billing_reconciliation_runs")
      .select("status, customers_examined, records_changed, failures, warnings, error")
      .eq("id", runId)
      .maybeSingle();
    if (data && data.status !== "running") return data;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 750));
  }
}

async function start(supabase: Supabase, path: string, body: Record<string, unknown>): Promise<string> {
  const answer = await callStripeReconcile(supabase, body);
  if (answer.status === 409) back(path, "error", "A billing reconciliation is already running. Try again when it finishes.");
  if (answer.status !== 202 || typeof answer.body?.run_id !== "string") back(path, "error", billingAnswerText(answer));
  return answer.body!.run_id as string;
}

export async function runBillingReconciliationAction() {
  const path = "/settings/billing";
  const supabase = await adminOnly(path);
  const runId = await start(supabase, path, {});
  const run = await waitForRun(supabase, runId);
  if (!run) back(path, "notice", "Reconciliation started and is still running. Refresh in a minute to see the result.");
  if (run.status === "failed") back(path, "error", `Reconciliation failed: ${run.error ?? "no reason recorded"}`);
  const found = run.records_changed > 0 ? `repaired ${run.records_changed} billing record${run.records_changed === 1 ? "" : "s"}` : "no differences";
  back(path, "notice",
    `Reconciled ${run.customers_examined} Stripe customer${run.customers_examined === 1 ? "" : "s"}: ${found}` +
    `${run.failures ? `; ${run.failures} failed` : ""}${run.warnings ? `; ${run.warnings} warning${run.warnings === 1 ? "" : "s"}` : ""}.`);
}

export async function reconcileClientAction(clientId: string) {
  if (!isUuid(clientId)) redirect("/clients");
  const path = `/clients/${clientId}/billing`;
  const supabase = await adminOnly(path);
  const runId = await start(supabase, path, { client_id: clientId });
  const run = await waitForRun(supabase, runId);
  if (!run) back(path, "notice", "Reconciliation started and is still running. Refresh in a minute to see the result.");
  if (run.status === "failed") back(path, "error", `Reconciliation failed: ${run.error ?? "no reason recorded"}`);
  const { data: result } = await supabase
    .from("billing_reconciliation_results")
    .select("status, records_changed, error")
    .eq("run_id", runId)
    .eq("client_id", clientId)
    .maybeSingle();
  back(path, result?.status === "failed" ? "error" : "notice", `Reconciled with Stripe: ${resultText(result)}.`);
}
