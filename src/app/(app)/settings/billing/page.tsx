import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTeamRole } from "@/lib/team";
import { formatMoney } from "@/lib/billing";
import { intervalText, modeLabel, oneTimeCategoryLabels } from "@/lib/billing-ops";
import {
  configurePortalAction,
  importStripeProductAction,
  mapPackagePriceAction,
  savePackageAction,
  savePackageEntitlementAction,
  saveOneTimeItemAction,
  setOneTimeItemActiveAction,
  setPackageActiveAction,
  setPackagePriceAction,
} from "@/app/billing-catalog-actions";
import { runBillingReconciliationAction } from "@/app/billing-reconcile-actions";
import { StripeSyncCard } from "@/components/billing/stripe-sync-card";
import { runLooksStuck, runStatusLabels, runStatusStyles, triggerLabels, warningText } from "@/lib/billing-reconcile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// Settings › Billing catalog (B3). What Compass sells and how it maps to
// Stripe. Admins change it; everyone on the team reads it. Amounts are never
// typed here: standard prices are created in Stripe and approved here, and a
// client's custom retainer price is created on that client's Billing tab.

type Price = {
  stripe_price_id: string;
  stripe_product_id: string;
  unit_amount_cents: number | null;
  currency: string;
  type: string;
  recurring_interval: string | null;
  recurring_interval_count: number | null;
  nickname: string | null;
  active: boolean;
  livemode: boolean;
};
const priceText = (p: Price) =>
  `${formatMoney(p.unit_amount_cents, p.currency)}${p.type === "recurring" ? ` / ${intervalText(p.recurring_interval, p.recurring_interval_count)}` : " one time"}`;

export default async function BillingCatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { error, notice } = await searchParams;
  const supabase = await createClient();
  const me = await getCurrentTeamRole(supabase);
  const isAdmin = me?.role === "admin";
  const [
    { data: livemode },
    { data: packages },
    { data: items },
    { data: services },
    { data: entitlements },
    { data: mappings },
    { data: products },
    { data: prices },
    { data: portal },
  ] = await Promise.all([
    supabase.rpc("billing_livemode"),
    supabase.from("billing_packages").select("*").order("sort_order").order("name"),
    supabase.from("billing_one_time_items").select("*").order("sort_order").order("name"),
    supabase.from("service_catalog").select("key, name, kind, unit, period").eq("active", true).order("sort_order"),
    supabase.from("package_entitlements").select("package_id, service_key, enabled, quantity"),
    supabase.from("billing_package_prices").select("id, package_id, stripe_price_id, client_id, is_default, active, clients(name)"),
    supabase.from("stripe_products").select("stripe_product_id, name, active, livemode, deleted_at"),
    supabase.from("stripe_prices").select("stripe_price_id, stripe_product_id, unit_amount_cents, currency, type, recurring_interval, recurring_interval_count, nickname, active, livemode"),
    supabase.from("app_settings").select("value").eq("key", "billing_portal").maybeSingle(),
  ]);
  const [{ data: syncHealth }, { data: runs }] = await Promise.all([
    supabase.from("billing_sync_health").select("*").maybeSingle(),
    supabase
      .from("billing_reconciliation_runs")
      .select("id, livemode, trigger, status, started_at, completed_at, customers_examined, records_changed, warnings, failures, events_recovered, error, summary, clients!billing_reconciliation_runs_scope_client_id_fkey(name), team_members(name)")
      .order("started_at", { ascending: false })
      .limit(10),
  ]);
  const live = livemode === true;
  const productOf = (id: string | null) => (products ?? []).find((p) => p.stripe_product_id === id);
  const pricesOf = (id: string | null) => ((prices ?? []) as Price[]).filter((p) => p.stripe_product_id === id);
  const priceById = (id: string) => ((prices ?? []) as Price[]).find((p) => p.stripe_price_id === id);
  const portalConf = ((portal?.value ?? {}) as Record<string, { configuration_id?: string; configured_at?: string }>)[live ? "live" : "test"];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/settings" className="text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">&larr; Settings</Link>
        <h1 className="page-title kicker">Billing catalog</h1>
        <p className="text-sm text-muted-foreground">
          Packages, what each includes, one-time items and their Stripe Products and Prices.
          {isAdmin ? " You are an admin: you can change them." : " Only an admin can change them."}
        </p>
      </div>
      <div className={`rounded-md border px-3 py-2 text-sm ${live ? "border-red-300 bg-red-50 text-red-900" : "border-amber-300 bg-amber-50 text-amber-900"}`} data-billing-mode={live ? "live" : "test"}>
        <strong>Stripe {modeLabel(live).toLowerCase()}.</strong> The mode is switched by an admin at cutover (docs/billing-cutover.md), never here.
      </div>
      {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}
      {notice && <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">{notice}</div>}

      <StripeSyncCard
        health={syncHealth}
        livemode={live}
        scope="agency"
        action={isAdmin ? runBillingReconciliationAction : undefined}
        actionLabel="Run Billing Reconciliation"
      />

      <Card data-card="reconciliation-runs">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recent reconciliation runs</CardTitle>
          <p className="text-xs text-muted-foreground">
            Daily once the schedule is on (after cutover); an admin can run one at any time. Each run re-reads the
            mapped catalog, every linked customer and any webhook that failed, and repairs Compass to match Stripe.
          </p>
        </CardHeader>
        <CardContent>
          {(runs ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>Customers</TableHead>
                  <TableHead>Repairs</TableHead>
                  <TableHead>Warnings</TableHead>
                  <TableHead>Failures</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(runs ?? []).map((r) => {
                  const summary = (r.summary ?? {}) as { warnings?: { code: string; detail?: string }[]; failures?: { error: string }[] };
                  const notes = [
                    ...(summary.warnings ?? []).map((w) => `${warningText(w.code)}${w.detail ? ` (${w.detail})` : ""}`),
                    ...(summary.failures ?? []).map((f) => f.error),
                    ...(r.error ? [r.error] : []),
                  ];
                  return (
                    <TableRow key={r.id} data-run={r.id}>
                      <TableCell>{new Date(r.started_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</TableCell>
                      <TableCell>{r.completed_at ? new Date(r.completed_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={runStatusStyles[r.status]}>
                          {runLooksStuck(r) ? "Stuck" : (runStatusLabels[r.status] ?? r.status)}
                        </Badge>
                        {notes.length > 0 && (
                          <details className="mt-1 text-xs text-muted-foreground">
                            <summary className="cursor-pointer">{notes.length} note{notes.length === 1 ? "" : "s"}</summary>
                            <ul className="list-disc pl-4">{notes.slice(0, 10).map((n, i) => <li key={i}>{n}</li>)}</ul>
                          </details>
                        )}
                      </TableCell>
                      <TableCell>{r.livemode ? "Live" : "Test"}</TableCell>
                      <TableCell>{triggerLabels[r.trigger] ?? r.trigger}{r.team_members?.name ? ` · ${r.team_members.name}` : ""}{r.clients?.name ? ` · ${r.clients.name}` : ""}</TableCell>
                      <TableCell>{r.customers_examined}</TableCell>
                      <TableCell>{r.records_changed}</TableCell>
                      <TableCell>{r.warnings}</TableCell>
                      <TableCell>{r.failures}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Stripe Customer Portal</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            Clients may update their payment method, download invoices and change billing contact details. They cannot
            change their package or quantity, cancel or pause: those are the agreement&apos;s.
          </p>
          <p>
            {portalConf?.configuration_id
              ? <>Configured: <span className="font-mono text-xs">{portalConf.configuration_id}</span></>
              : "Not configured yet."}
          </p>
          {isAdmin && (
            <form action={configurePortalAction}>
              <Button type="submit" size="sm" variant="outline">{portalConf?.configuration_id ? "Check configuration" : "Configure Customer Portal"}</Button>
            </form>
          )}
        </CardContent>
      </Card>

      <h2 className="text-lg font-semibold">Packages</h2>
      {(packages ?? []).map((pkg) => {
        const product = productOf(pkg.stripe_product_id);
        const mapped = (mappings ?? []).filter((m) => m.package_id === pkg.id);
        const mappedIds = new Set(mapped.map((m) => m.stripe_price_id));
        const approvable = pricesOf(pkg.stripe_product_id).filter((p) => p.type === "recurring" && p.active && !mappedIds.has(p.stripe_price_id));
        return (
          <Card key={pkg.id} data-package={pkg.key}>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">{pkg.name}</CardTitle>
                <Badge variant="outline">{pkg.kind === "custom" ? "Custom retainer" : "Standard"}</Badge>
                {!pkg.active && <Badge variant="outline" className="bg-zinc-100">Retired</Badge>}
                <span className="font-mono text-xs text-muted-foreground">{pkg.key}</span>
              </div>
              {pkg.description && <p className="text-sm text-muted-foreground">{pkg.description}</p>}
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="space-y-1">
                <p className="font-medium">Stripe Product</p>
                {product ? (
                  <p>
                    {product.name} <span className="font-mono text-xs text-muted-foreground">{product.stripe_product_id}</span>
                    {product.livemode !== live && <span className="text-red-800"> — {product.livemode ? "live" : "test"} product; re-import in {modeLabel(live).toLowerCase()}</span>}
                    {!product.active && <span className="text-red-800"> — archived in Stripe</span>}
                  </p>
                ) : (
                  <p className="text-muted-foreground">Not mapped.</p>
                )}
                {isAdmin && (
                  <form action={importStripeProductAction.bind(null, "package", pkg.id)} className="flex gap-2">
                    <Input name="product_id" placeholder="prod_…" required className="w-64" aria-label={`Stripe product for ${pkg.name}`} />
                    <Button type="submit" size="sm" variant="outline">{product ? "Re-import" : "Import from Stripe"}</Button>
                  </form>
                )}
              </div>

              <div className="space-y-1">
                <p className="font-medium">{pkg.kind === "custom" ? "Client prices" : "Approved prices"}</p>
                {mapped.length === 0 ? (
                  <p className="text-muted-foreground">
                    {pkg.kind === "custom" ? "None yet: each is created on a client's Billing tab." : "None approved yet."}
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Price</TableHead>
                        {pkg.kind === "custom" && <TableHead>Client</TableHead>}
                        <TableHead>Stripe</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {mapped.map((m) => {
                        const p = priceById(m.stripe_price_id);
                        return (
                          <TableRow key={m.id} data-price={m.stripe_price_id}>
                            <TableCell>{p ? priceText(p) : "—"}{p?.nickname ? ` — ${p.nickname}` : ""}</TableCell>
                            {pkg.kind === "custom" && <TableCell>{m.clients?.name ?? "—"}</TableCell>}
                            <TableCell className="font-mono text-xs">{m.stripe_price_id}{p && !p.active ? " (archived)" : ""}</TableCell>
                            <TableCell>{m.active ? (m.is_default ? "Default" : "Approved") : "Retired"}</TableCell>
                            <TableCell className="space-x-1 whitespace-nowrap">
                              {isAdmin && m.active && !m.is_default && pkg.kind === "standard" && (
                                <form action={setPackagePriceAction.bind(null, m.id, { is_default: true })} className="inline">
                                  <Button type="submit" size="sm" variant="ghost">Make default</Button>
                                </form>
                              )}
                              {isAdmin && (
                                <form action={setPackagePriceAction.bind(null, m.id, { active: !m.active, ...(m.active ? { is_default: false } : {}) })} className="inline">
                                  <Button type="submit" size="sm" variant="ghost">{m.active ? "Retire" : "Approve again"}</Button>
                                </form>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
                {isAdmin && pkg.kind === "standard" && approvable.length > 0 && (
                  <form action={mapPackagePriceAction.bind(null, pkg.id)} className="flex flex-wrap items-center gap-2 pt-1">
                    <select name="stripe_price_id" className="field" aria-label={`Price to approve for ${pkg.name}`}>
                      {approvable.map((p) => <option key={p.stripe_price_id} value={p.stripe_price_id}>{priceText(p)}{p.nickname ? ` — ${p.nickname}` : ""} ({p.stripe_price_id})</option>)}
                    </select>
                    <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="is_default" /> default</label>
                    <Button type="submit" size="sm" variant="outline">Approve for Checkout</Button>
                  </form>
                )}
              </div>

              <div className="space-y-1">
                <p className="font-medium">Includes</p>
                <Table>
                  <TableBody>
                    {(services ?? []).map((s) => {
                      const e = (entitlements ?? []).find((x) => x.package_id === pkg.id && x.service_key === s.key);
                      const text = !e?.enabled ? "Not included" : s.kind === "feature" ? "Included" : `${e.quantity} ${s.unit} / ${s.period}`;
                      return (
                        <TableRow key={s.key} data-entitlement={`${pkg.key}:${s.key}`}>
                          <TableCell className="w-1/3">{s.name}</TableCell>
                          <TableCell>{text}</TableCell>
                          <TableCell className="text-right">
                            {isAdmin && (
                              <details>
                                <summary className="cursor-pointer text-xs underline">Change</summary>
                                <form action={savePackageEntitlementAction.bind(null, pkg.id, s.key)} className="mt-2 flex items-center justify-end gap-2">
                                  <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="enabled" defaultChecked={!!e?.enabled} /> included</label>
                                  {s.kind === "quota" && <Input name="quantity" type="number" min={0} defaultValue={e?.quantity ?? ""} className="w-20" aria-label="Quantity" />}
                                  <Button type="submit" size="sm" variant="outline">Save</Button>
                                </form>
                              </details>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {isAdmin && (
                <div className="flex flex-wrap gap-2 border-t pt-3">
                  <details>
                    <summary className="cursor-pointer text-xs underline">Edit name and description</summary>
                    <form action={savePackageAction} className="mt-2 grid gap-2 sm:grid-cols-3">
                      <input type="hidden" name="id" value={pkg.id} />
                      <input type="hidden" name="key" value={pkg.key} />
                      <input type="hidden" name="kind" value={pkg.kind} />
                      <Input name="name" defaultValue={pkg.name} aria-label="Name" />
                      <Input name="description" defaultValue={pkg.description ?? ""} aria-label="Description" />
                      <Input name="sort_order" type="number" defaultValue={pkg.sort_order} aria-label="Sort order" />
                      <Button type="submit" size="sm" variant="outline">Save</Button>
                    </form>
                  </details>
                  <form action={setPackageActiveAction.bind(null, pkg.id, !pkg.active)}>
                    <Button type="submit" size="sm" variant="ghost">{pkg.active ? "Retire package" : "Offer again"}</Button>
                  </form>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
      {isAdmin && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">New package</CardTitle></CardHeader>
          <CardContent>
            <form action={savePackageAction} className="grid gap-3 sm:grid-cols-4 text-sm">
              <div className="space-y-1"><Label htmlFor="pkg-name">Name</Label><Input id="pkg-name" name="name" required /></div>
              <div className="space-y-1"><Label htmlFor="pkg-key">Key</Label><Input id="pkg-key" name="key" required placeholder="growth_plus" /></div>
              <div className="space-y-1">
                <Label htmlFor="pkg-kind">Kind</Label>
                <select id="pkg-kind" name="kind" className="field w-full" defaultValue="standard">
                  <option value="standard">Standard (fixed Stripe prices)</option>
                  <option value="custom">Custom retainer (a price per client)</option>
                </select>
              </div>
              <div className="space-y-1"><Label htmlFor="pkg-sort">Sort order</Label><Input id="pkg-sort" name="sort_order" type="number" defaultValue={0} /></div>
              <div className="space-y-1 sm:col-span-3"><Label htmlFor="pkg-desc">Description</Label><Input id="pkg-desc" name="description" /></div>
              <div className="flex items-end"><Button type="submit" size="sm">Add package</Button></div>
            </form>
          </CardContent>
        </Card>
      )}

      <h2 className="text-lg font-semibold">One-time items</h2>
      <p className="text-sm text-muted-foreground">Website builds, setup fees and special projects. Never part of a recurring price.</p>
      <Card>
        <CardContent className="pt-4">
          {(items ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Stripe Product</TableHead>
                  <TableHead>Prices</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(items ?? []).map((it) => {
                  const product = productOf(it.stripe_product_id);
                  return (
                    <TableRow key={it.id} data-item={it.key}>
                      <TableCell>{it.name}{!it.active ? " (retired)" : ""}</TableCell>
                      <TableCell>{oneTimeCategoryLabels[it.category] ?? it.category}</TableCell>
                      <TableCell>
                        {product ? <span className="font-mono text-xs">{product.stripe_product_id}</span> : <span className="text-muted-foreground">Not mapped</span>}
                        {isAdmin && (
                          <form action={importStripeProductAction.bind(null, "one_time_item", it.id)} className="mt-1 flex gap-1">
                            <Input name="product_id" placeholder="prod_…" required className="h-8 w-40" aria-label={`Stripe product for ${it.name}`} />
                            <Button type="submit" size="sm" variant="ghost">Import</Button>
                          </form>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {pricesOf(it.stripe_product_id).filter((p) => p.active).map((p) => <div key={p.stripe_price_id}>{priceText(p)}</div>)}
                      </TableCell>
                      <TableCell>
                        {isAdmin && (
                          <form action={setOneTimeItemActiveAction.bind(null, it.id, !it.active)}>
                            <Button type="submit" size="sm" variant="ghost">{it.active ? "Retire" : "Offer again"}</Button>
                          </form>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {isAdmin && (
            <form action={saveOneTimeItemAction} className="mt-4 grid gap-3 border-t pt-4 text-sm sm:grid-cols-4">
              <div className="space-y-1"><Label htmlFor="item-name">Name</Label><Input id="item-name" name="name" required /></div>
              <div className="space-y-1"><Label htmlFor="item-key">Key</Label><Input id="item-key" name="key" required placeholder="website_build" /></div>
              <div className="space-y-1">
                <Label htmlFor="item-category">Category</Label>
                <select id="item-category" name="category" className="field w-full" defaultValue="website_project">
                  {Object.entries(oneTimeCategoryLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div className="flex items-end"><Button type="submit" size="sm">Add item</Button></div>
              <div className="space-y-1 sm:col-span-4"><Label htmlFor="item-desc">Description</Label><Input id="item-desc" name="description" /></div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
