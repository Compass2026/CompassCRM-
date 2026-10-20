import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { citationsEnabled } from "@/lib/citations-flag";
import { inView, listingView, loadListings, loadOpenTasks, summarize, LISTING_VIEWS } from "@/lib/citations-data";
import { REQUEST_STATUSES, type CitationCreditBalance, type CitationLocation, type CitationRequest, type CitationTask } from "@/lib/citations";
import { FreshnessBadge, FulfillmentBadge, PhaseNote, SummaryCards, VerificationBadge, ViewNav } from "@/components/citations/citation-bits";
import { CreditEntryForm, PROVIDERS } from "@/components/citations/citation-forms";

export const dynamic = "force-dynamic";

const money = (n: number, c: string) => `${c === "USD" ? "$" : `${c} `}${n.toFixed(2)}`;
function sumBy(rows: { amount: number | null; currency: string }[]) {
  const out = new Map<string, number>();
  for (const r of rows) if (r.amount !== null) out.set(r.currency, (out.get(r.currency) ?? 0) + Number(r.amount));
  return [...out].map(([c, n]) => money(n, c)).join(" + ") || "$0.00";
}

// Agency overview: every client's business locations, what the evidence
// says, what is open, and what fulfillment has cost (cash and credits apart).
export default async function CitationsOverviewPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  if (!citationsEnabled()) notFound();
  const view = listingView((await searchParams).view);
  const db = await createClient();
  const [{ listings, error }, tasksQ, locsQ, clientsQ, requestsQ, balancesQ] = await Promise.all([
    loadListings(db, {}), loadOpenTasks(db, {}),
    db.from("citation_locations").select("*").eq("status", "active").order("label"),
    db.from("clients").select("id, name").order("name"),
    db.from("citation_fulfillment_requests").select("*").order("created_at", { ascending: false }).limit(1000),
    db.from("citation_credit_balances").select("*"),
  ]);
  const failure = error ?? (tasksQ.error || locsQ.error || clientsQ.error || requestsQ.error || balancesQ.error ? "Citations could not be read. Refresh to retry." : null);
  const tasks = (tasksQ.data ?? []) as CitationTask[];
  const locations = (locsQ.data ?? []) as CitationLocation[];
  const clientName = new Map((clientsQ.data ?? []).map((c) => [c.id, c.name]));
  const requests = (requestsQ.data ?? []) as CitationRequest[];
  const balances = (balancesQ.data ?? []) as CitationCreditBalance[];
  const total = summarize(listings, tasks.length);
  const perLocation = locations.map((l) => ({ l, s: summarize(listings.filter((x) => x.location_id === l.id), tasks.filter((t) => t.location_id === l.id).length) }))
    .sort((a, b) => (clientName.get(a.l.client_id) ?? "").localeCompare(clientName.get(b.l.client_id) ?? "") || a.l.label.localeCompare(b.l.label));
  const matching = view === "all" ? [] : listings.filter((l) => inView(l, view)).slice(0, 200);
  const awaitingApproval = requests.filter((r) => r.status === "pending_approval");

  return <div className="space-y-6" data-citations-overview>
    <div className="rounded-2xl bg-navy-900 p-6 text-white">
      <p className="text-xs uppercase tracking-widest text-blue-200">Local listings</p>
      <h1 className="mt-2 text-2xl font-semibold text-white">Citations</h1>
      <p className="mt-2 text-sm text-blue-100">Every directory listing by client and business location, with provider status and independently verified accuracy kept apart.</p>
    </div>
    <PhaseNote />
    {failure && <p role="alert" className="callout">{failure}</p>}
    <SummaryCards s={total} />

    <section className="surface overflow-x-auto p-0">
      <table className="w-full min-w-[56rem] text-left text-sm" data-location-table>
        <thead className="bg-royal-50/80 text-xs text-muted-foreground"><tr>
          <th className="px-4 py-2">Client · location</th><th className="px-2 py-2">Listings</th><th className="px-2 py-2">Verified</th><th className="px-2 py-2">Discrepancy</th>
          <th className="px-2 py-2">Unverified</th><th className="px-2 py-2">Provider complete, unverified</th><th className="px-2 py-2">Open tasks</th><th className="px-2 py-2">Stale / never</th><th className="px-2 py-2">Action</th></tr></thead>
        <tbody>{perLocation.map(({ l, s }) => <tr key={l.id} className="border-t" data-location-row={l.label}>
          <td className="px-4 py-2"><Link className="font-medium text-blue-700 underline" href={`/clients/${l.client_id}/citations/${l.id}`}>{clientName.get(l.client_id) ?? "Client"} · {l.label}</Link>
            {l.hide_address && <span className="ml-2 text-xs text-muted-foreground">address hidden</span>}</td>
          <td className="px-2 py-2">{s.total}</td><td className="px-2 py-2">{s.byVerification.verified_accurate}</td><td className="px-2 py-2">{s.byVerification.discrepancy}</td>
          <td className="px-2 py-2">{s.byVerification.unverified}</td><td className="px-2 py-2">{s.providerCompleteUnverified}</td><td className="px-2 py-2">{s.openTasks}</td>
          <td className="px-2 py-2">{s.stale + s.never}</td><td className="px-2 py-2 font-semibold">{s.action}</td></tr>)}
          {!perLocation.length && <tr><td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">No business locations yet. Open a client&apos;s Citations tab to add its approved identity.</td></tr>}
        </tbody>
      </table>
    </section>

    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Listings by status</h2>
      <ViewNav base="/citations" view={view} />
      {view === "all" ? <p className="text-sm text-muted-foreground">Choose a filter to list matching listings across every client.</p>
        : !matching.length ? <p className="surface p-6 text-center text-sm text-muted-foreground">No listings are {LISTING_VIEWS[view].toLowerCase()}.</p>
        : <ul className="space-y-2" data-filtered-listings>{matching.map((l) => <li key={l.id} className="surface flex flex-wrap items-center gap-2 p-3 text-sm">
          <Link className="font-medium text-blue-700 underline" href={`/clients/${l.client_id}/citations/${l.location_id}`}>{l.client_name} · {l.location_label}</Link>
          <span>{l.directory_name}</span><VerificationBadge status={l.verification_status} /><FulfillmentBadge status={l.fulfillment_status} /><FreshnessBadge lastCheckedOn={l.last_checked_on} />
          {l.open_tasks > 0 && <span className="text-xs">{l.open_tasks} open task{l.open_tasks > 1 ? "s" : ""}</span>}</li>)}</ul>}
    </section>

    <section className="grid gap-4 lg:grid-cols-2">
      <div className="surface space-y-3 p-5" data-fulfillment-costs>
        <h2 className="font-semibold">Manual fulfillment</h2>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div><dt className="text-xs text-muted-foreground">One-time cash recorded</dt><dd className="text-lg font-semibold">{sumBy(requests.map((r) => ({ amount: r.actual_amount, currency: r.actual_currency })))}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Prepaid credits used</dt><dd className="text-lg font-semibold">{requests.reduce((n, r) => n + (r.credits_used ?? 0), 0)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Approved budgets</dt><dd className="text-lg font-semibold">{sumBy(requests.filter((r) => r.approved_at && r.status !== "cancelled").map((r) => ({ amount: r.approved_budget, currency: r.budget_currency })))}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Awaiting approval</dt><dd className="text-lg font-semibold">{awaitingApproval.length}</dd></div>
        </dl>
        <p className="text-xs text-muted-foreground">Recorded here only: nothing orders, submits or spends. Recurring subscriptions and internal labor are not tracked in this module (docs/citations.md, cost measurement points).</p>
        {awaitingApproval.length > 0 && <ul className="space-y-1 text-sm">{awaitingApproval.slice(0, 20).map((r) =>
          <li key={r.id}><Link className="text-blue-700 underline" href={`/clients/${r.client_id}/citations/${r.location_id}#requests`}>{clientName.get(r.client_id)}: {REQUEST_STATUSES[r.status]}</Link>{r.approved_budget !== null && ` · ${money(Number(r.approved_budget), r.budget_currency)}`}</li>)}</ul>}
      </div>
      <div className="surface space-y-3 p-5" data-credit-balances>
        <h2 className="font-semibold">Prepaid credits</h2>
        {balances.length ? <table className="w-full text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th>Provider</th><th>Recorded</th><th>Used</th><th>Remaining</th><th>Purchase cash</th></tr></thead>
          <tbody>{balances.map((b) => <tr key={b.provider} className="border-t"><td className="py-1">{PROVIDERS[b.provider as keyof typeof PROVIDERS] ?? b.provider}</td><td>{b.credits_recorded}</td><td>{b.credits_used}</td>
            <td className="font-semibold" data-credits-remaining={b.provider}>{b.credits_recorded ? b.credits_recorded - b.credits_used : "No balance recorded"}</td><td>{money(Number(b.credit_purchase_cash), "USD")}</td></tr>)}</tbody></table>
          : <p className="text-sm text-muted-foreground">No credits recorded. Record an opening balance from the provider&apos;s account page.</p>}
        <CreditEntryForm />
      </div>
    </section>
  </div>;
}
