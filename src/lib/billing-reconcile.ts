// Reconciliation display rules (B4). Pure: shared by Settings › Billing, the
// client Billing tab, the reconcile actions and the tests. Reconciliation is
// the safety net behind Stripe's webhooks; these only word what a run found.

export const runStatusLabels: Record<string, string> = {
  running: "Running",
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  partial: "Partial (time limit)",
  failed: "Failed",
};

export const runStatusStyles: Record<string, string> = {
  running: "bg-blue-100 text-blue-800 border-blue-200",
  completed: "bg-green-100 text-green-800 border-green-200",
  completed_with_errors: "bg-amber-100 text-amber-800 border-amber-200",
  partial: "bg-amber-100 text-amber-800 border-amber-200",
  failed: "bg-red-100 text-red-800 border-red-200",
};

export const triggerLabels: Record<string, string> = {
  schedule: "Scheduled",
  admin: "Admin",
  admin_client: "Admin (one client)",
};

// category → [one, many]
export const changeLabels: Record<string, [string, string]> = {
  customer_updated: ["customer detail update", "customer detail updates"],
  subscription_imported: ["subscription imported", "subscriptions imported"],
  subscription_updated: ["subscription updated", "subscriptions updated"],
  invoice_imported: ["invoice imported", "invoices imported"],
  invoice_updated: ["invoice updated", "invoices updated"],
  invoice_removed: ["draft invoice removed", "draft invoices removed"],
  payment_imported: ["payment imported", "payments imported"],
  payment_updated: ["payment updated", "payments updated"],
  refund_imported: ["refund imported", "refunds imported"],
  refund_updated: ["refund updated", "refunds updated"],
  checkout_updated: ["payment link updated", "payment links updated"],
  catalog_product_imported: ["catalog product imported", "catalog products imported"],
  catalog_product_updated: ["catalog product updated", "catalog products updated"],
  catalog_price_imported: ["catalog price imported", "catalog prices imported"],
  catalog_price_updated: ["catalog price updated", "catalog prices updated"],
};

export const warningLabels: Record<string, string> = {
  customer_deleted_in_stripe: "The Stripe customer was deleted in Stripe",
  catalog_price_archived: "An approved price is archived in Stripe",
  catalog_product_archived: "A package's Stripe product is archived",
  catalog_product_other_mode: "A package maps a product from the other Stripe mode",
};

export function warningText(code: string): string {
  if (code.startsWith("checkout_missing:")) return `Stripe no longer has payment link ${code.slice(17)}`;
  return warningLabels[code] ?? code.replaceAll("_", " ");
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// "No differences" / "Repaired 3 billing records" / "Needs attention" / "Failed".
export function resultText(r: { status: string; records_changed: number | null; error?: string | null } | null | undefined): string {
  if (!r) return "Not reconciled yet";
  if (r.status === "failed") return `Failed${r.error ? `: ${r.error}` : ""}`;
  const n = r.records_changed ?? 0;
  const repaired = n > 0 ? `Repaired ${plural(n, "billing record")}` : "No differences";
  return r.status === "attention" ? `${repaired} · needs attention` : repaired;
}

export function changesText(changes: Record<string, number> | null | undefined): string {
  const parts = Object.entries(changes ?? {}).filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${changeLabels[k]?.[n === 1 ? 0 : 1] ?? k.replaceAll("_", " ")}`);
  return parts.join(", ");
}

// The webhook side of "Stripe sync": failures the ledger still holds.
export function webhookText(h: { failed_events: number | null; stuck_events: number | null; last_event_at: string | null } | null | undefined): { ok: boolean; text: string } {
  if (!h) return { ok: true, text: "No events yet" };
  const failed = h.failed_events ?? 0;
  const stuck = h.stuck_events ?? 0;
  if (failed + stuck === 0) return { ok: true, text: h.last_event_at ? "Healthy" : "No events received yet" };
  const parts = [failed ? plural(failed, "failed event") : null, stuck ? plural(stuck, "stuck event") : null].filter(Boolean);
  return { ok: false, text: `${parts.join(", ")} — the next reconciliation retries them` };
}

// A run that is still running after this long is shown as stuck (0061 closes
// it as failed when the next run begins, after 30 minutes).
export function runLooksStuck(r: { status: string; started_at: string }, now = new Date()): boolean {
  return r.status === "running" && now.getTime() - Date.parse(r.started_at) > 30 * 60_000;
}
