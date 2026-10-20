import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { citationsEnabled } from "@/lib/citations-flag";
import { isUuid } from "@/lib/tasks";
import { getCurrentTeamRole, listTeamMembers } from "@/lib/team";
import { fetchAll } from "@/lib/fetch-all";
import { inView, listingView, loadListings, summarize, LISTING_VIEWS } from "@/lib/citations-data";
import {
  CHECK_METHODS, CHECK_RESULTS, OPEN_TASK_STATUSES, REQUEST_ACTIONS, REQUEST_STATUSES, TASK_KINDS, TASK_STATUSES, compareListing, comparisonSource, identityAddress,
  type CitationCheck, type CitationLocation, type CitationLocationIdentity, type CitationRequest, type CitationTask,
} from "@/lib/citations";
import { FieldChip, FreshnessBadge, FulfillmentBadge, PhaseNote, SummaryCards, VerificationBadge, ViewNav } from "@/components/citations/citation-bits";
import { AddListingForm, CheckForm, EditLocationForm, OpenTaskForm, PROVIDERS, QueueVerificationButton, RequestForm, RequestUpdateForm, TaskUpdateForm } from "@/components/citations/citation-forms";

export const dynamic = "force-dynamic";

// Listings are counted and filtered in full; only the display is paged.
const PAGE = 100;

export default async function CitationLocationPage({ params, searchParams }: { params: Promise<{ clientId: string; locationId: string }>; searchParams: Promise<{ view?: string; page?: string }> }) {
  if (!citationsEnabled()) notFound();
  const { clientId, locationId } = await params;
  if (!isUuid(clientId) || !isUuid(locationId)) notFound();
  const sp = await searchParams;
  const view = listingView(sp.view);
  const db = await createClient();
  const { data: location } = await db.from("citation_locations").select("*").eq("client_id", clientId).eq("id", locationId).maybeSingle();
  if (!location) notFound();
  const loc = location as CitationLocation;
  const [{ listings, error }, tasksQ, requestsQ, historyQ, dirsQ, trackingQ, brandsQ, team, role] = await Promise.all([
    loadListings(db, { clientId, locationId }),
    fetchAll<CitationTask>((from, to) => db.from("citation_tasks").select("*", { count: "exact" }).eq("client_id", clientId).eq("location_id", locationId).order("opened_at", { ascending: false }).order("id").range(from, to)),
    fetchAll<CitationRequest>((from, to) => db.from("citation_fulfillment_requests").select("*", { count: "exact" }).eq("client_id", clientId).eq("location_id", locationId).order("created_at", { ascending: false }).order("id").range(from, to)),
    db.from("citation_location_identities").select("*").eq("location_id", locationId).order("version", { ascending: false }).limit(50),
    fetchAll<{ id: string; name: string }>((from, to) => db.from("citation_directories").select("id, name", { count: "exact" }).eq("is_active", true).order("name").order("id").range(from, to)),
    db.from("locations").select("id, name").eq("client_id", clientId).order("sort_order"),
    db.from("client_brand_workspaces").select("id, name").eq("client_id", clientId).order("name"),
    listTeamMembers(db), getCurrentTeamRole(db),
  ]);
  const visible = listings.filter((l) => inView(l, view));
  const pages = Math.max(1, Math.ceil(visible.length / PAGE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1));
  const shown = visible.slice((page - 1) * PAGE, page * PAGE);
  // Full check history for the listings on this page only. The latest
  // evidence per listing comes from the overview projection, so a busy
  // listing's history can never displace another listing's latest check.
  const ids = shown.map((l) => l.id);
  const checksQ = ids.length
    ? await fetchAll<CitationCheck>((from, to) => db.from("citation_checks").select("*", { count: "exact" }).in("listing_id", ids)
      .order("checked_on", { ascending: false }).order("recorded_at", { ascending: false }).order("seq", { ascending: false }).range(from, to))
    : { rows: [] as CitationCheck[], error: null };
  const failure = error ?? tasksQ.error ?? requestsQ.error ?? dirsQ.error ?? checksQ.error;
  const tasks = tasksQ.rows;
  const openTasks = tasks.filter((t) => OPEN_TASK_STATUSES.includes(t.status));
  const requests = requestsQ.rows;
  const checks = checksQ.rows;
  const history = (historyQ.data ?? []) as CitationLocationIdentity[];
  const directories = dirsQ.rows;
  const teamOptions = team.map((t) => ({ id: t.id, name: t.name }));
  const dirName = new Map(directories.map((d) => [d.id, d.name]));
  const listingName = (id: string | null) => { const l = listings.find((x) => x.id === id); return l ? `${l.directory_name}${l.listing_url ? ` · ${l.listing_url.replace(/^https?:\/\/(www\.)?/, "")}` : l.external_id ? ` · ${l.external_id}` : ""}` : "Location"; };
  const listingOptions = listings.map((l) => ({ id: l.id, name: listingName(l.id), directory_id: l.directory_id }));
  const base = `/clients/${clientId}/citations/${locationId}`;
  const pageHref = (p: number) => `${base}?${new URLSearchParams({ ...(view !== "all" ? { view } : {}), ...(p > 1 ? { page: String(p) } : {}) })}`;
  const member = (id: string | null) => team.find((t) => t.id === id)?.name ?? "Unassigned";

  return <div className="space-y-6" data-citation-location>
    <Link href={`/clients/${clientId}/citations`} className="text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">&larr; All locations</Link>
    <section className="surface space-y-3 p-5" data-identity>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><h2 className="text-xl font-semibold">{loc.label}</h2><p className="text-xs text-muted-foreground" data-identity-version={loc.identity_version}>Approved identity v{loc.identity_version} · {loc.approved_at.slice(0, 10)}{loc.status === "archived" ? " · archived" : ""}</p></div>
        <div className="flex gap-2 text-sm">
          <a className="rounded-full bg-blue-50 px-3 py-2 font-medium text-blue-800" href={`/clients/${clientId}/citations/export?variant=client&location=${locationId}`}>Export (client-safe)</a>
          <a className="rounded-full bg-blue-50 px-3 py-2 font-medium text-blue-800" href={`/clients/${clientId}/citations/export?variant=internal&location=${locationId}`}>Export (internal)</a>
        </div>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-muted-foreground">Business name</dt><dd>{loc.business_name}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Address</dt><dd data-approved-address>{identityAddress(loc) || "—"}{loc.hide_address && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">Hidden: team only, never in client outputs</span>}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Phone</dt><dd>{loc.phone || "—"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Website</dt><dd className="break-all">{loc.website_url ?? "—"}</dd></div>
      </dl>
      <details className="border-t pt-3"><summary className="cursor-pointer text-sm font-medium">Edit approved identity</summary>
        <div className="mt-3"><EditLocationForm key={loc.updated_at} location={loc} trackingLocations={(trackingQ.data ?? []).map((l) => ({ id: l.id, name: l.name }))} brands={brandsQ.data ?? []} /></div></details>
      <details className="border-t pt-3"><summary className="cursor-pointer text-sm font-medium">Identity history ({history.length}{history.length === 50 ? ", latest 50" : ""})</summary>
        <ul className="mt-3 space-y-2 text-xs">{history.map((h) => <li key={h.id} className="border-t pt-2"><p className="font-semibold">v{h.version} · {h.recorded_at.slice(0, 10)} · {h.note || "—"}</p>
          <p className="text-muted-foreground">{h.business_name} · {identityAddress(h) || "no street"}{h.hide_address ? " (hidden)" : ""} · {h.phone || "no phone"} · {h.website_url ?? "no website"}</p></li>)}</ul></details>
    </section>

    <PhaseNote />
    {failure && <p role="alert" className="callout" data-incomplete>{failure} Counts and listings are hidden until every record can be read.</p>}
    {!failure && <>
    <SummaryCards s={summarize(listings, openTasks.length)} />

    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-lg font-semibold">Listings</h3>
        <div className="flex flex-wrap gap-2"><QueueVerificationButton clientId={clientId} locationId={locationId} /><AddListingForm clientId={clientId} locationId={locationId} directories={directories} /><OpenTaskForm clientId={clientId} locationId={locationId} listings={listingOptions} team={teamOptions} /></div></div>
      <ViewNav base={base} view={view} />
      <p className="text-xs text-muted-foreground" data-listing-range>{visible.length ? `Showing ${(page - 1) * PAGE + 1}–${(page - 1) * PAGE + shown.length} of ${visible.length}` : "0"} {view === "all" ? "listings" : LISTING_VIEWS[view].toLowerCase()}{listings.length !== visible.length ? ` (of ${listings.length} listings)` : ""}.</p>
      {!visible.length && <p className="surface p-8 text-center text-sm text-muted-foreground">No listings in this view.</p>}
      <div className="space-y-3" data-listings>{shown.map((l) => {
        const own = checks.filter((c) => c.listing_id === l.id);
        const compared = comparisonSource(l);
        const cmp = compareListing(loc, compared.fields);
        const listingTasks = openTasks.filter((t) => t.listing_id === l.id);
        const hasSource = !!(l.source_name || l.source_address || l.source_phone || l.source_website);
        return <article key={l.id} className="surface min-w-0 p-4" data-listing={l.directory_name} data-listing-url={l.listing_url ?? ""}>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-semibold">{l.directory_name}</h4>
            <VerificationBadge status={l.verification_status} /><FulfillmentBadge status={l.fulfillment_status} /><FreshnessBadge listing={l} />
            {l.suspected_duplicate && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800" data-duplicate>Suspected duplicate</span>}
            {listingTasks.length > 0 && <span className="text-xs font-medium">{listingTasks.length} open task{listingTasks.length > 1 ? "s" : ""}</span>}
          </div>
          <p className="mt-2 break-all text-sm">{l.listing_url ? <a className="text-blue-700 underline" href={l.listing_url} target="_blank" rel="noreferrer">{l.listing_url}</a> : <span className="text-muted-foreground">No listing URL{l.external_id ? ` · id ${l.external_id}` : ""}</span>}</p>
          {l.verification_status === "needs_reverification" && <p className="mt-2 text-xs text-orange-800" data-reverify>The approved identity is now v{l.identity_version}; the latest check ({l.last_checked_on}) was made against {l.check_identity_version ? `v${l.check_identity_version}` : "no approved identity"}. Record a new check to verify it.</p>}
          <div className="mt-2 flex flex-wrap items-center gap-1" data-current-evidence={compared.from}>{(["name", "address", "phone", "website"] as const).map((f) => <FieldChip key={f} field={f} value={cmp[f]} />)}
            <span className="text-xs text-muted-foreground">{compared.from === "check" ? `from the ${l.last_checked_on} check (identity v${l.check_identity_version})`
              : compared.from === "source" ? "from the imported observation, not verified"
              : l.last_check_result ? `latest check: ${CHECK_RESULTS[l.last_check_result].toLowerCase()} on ${l.last_checked_on}, nothing observed` : "nothing observed yet"}</span></div>
          {compared.from === "check" && <dl className="mt-2 grid gap-x-4 text-xs sm:grid-cols-4" data-current-values>{([["Name", l.current_name], ["Address", l.current_address], ["Phone", l.current_phone], ["Website", l.current_website]] as const).map(([k, v]) =>
            <div key={k}><dt className="text-muted-foreground">Current {k.toLowerCase()}</dt><dd className="break-words" data-current={k.toLowerCase()}>{v || "not recorded"}</dd></div>)}</dl>}
          <p className="mt-2 text-xs text-muted-foreground" data-source-observation>Imported: {l.source_provider ?? "—"}{l.source_observed_on ? ` · observed ${l.source_observed_on}` : ""}{l.last_imported_at ? ` · imported ${l.last_imported_at.slice(0, 10)}` : ""}
            {hasSource && ` · ${[l.source_name, l.source_phone, l.source_address, l.source_website].filter(Boolean).join(" · ")}`}</p>
          <details className="mt-3 border-t pt-3"><summary className="cursor-pointer text-sm font-medium">Checks &amp; evidence ({own.length})</summary>
            <div className="mt-3 space-y-3"><CheckForm clientId={clientId} listingId={l.id} />
              <ul className="space-y-2 text-xs" data-checks>{own.map((c) => <li key={c.id} className="border-t pt-2"><p className="font-semibold">{c.checked_on} · {CHECK_RESULTS[c.result]} · {CHECK_METHODS[c.method]} · identity {c.identity_version ? `v${c.identity_version}` : "none"}</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{c.evidence}{c.evidence_url && <> · <a className="text-blue-700 underline" href={c.evidence_url} target="_blank" rel="noreferrer">evidence</a></>}</p></li>)}</ul></div></details>
          <details className="mt-3 border-t pt-3"><summary className="cursor-pointer text-sm font-medium">Open a task for this listing</summary>
            <div className="mt-3"><OpenTaskForm clientId={clientId} locationId={locationId} listings={[{ id: l.id, name: listingName(l.id) }]} team={teamOptions} defaultListing={l.id} /></div></details>
        </article>;
      })}</div>
      {pages > 1 && <nav className="flex flex-wrap items-center gap-2 text-sm" aria-label="Listing pages">
        {page > 1 && <Link className="rounded-full bg-blue-50 px-3 py-2 text-blue-800" href={pageHref(page - 1)}>Previous</Link>}
        <span data-page={page}>Page {page} of {pages}</span>
        {page < pages && <Link className="rounded-full bg-blue-50 px-3 py-2 text-blue-800" href={pageHref(page + 1)}>Next</Link>}
      </nav>}
    </section>

    <section className="space-y-3" id="tasks" data-tasks>
      <h3 className="text-lg font-semibold">Correction &amp; verification tasks</h3>
      {!tasks.length && <p className="text-sm text-muted-foreground">No tasks yet.</p>}
      {tasks.map((t) => <article key={t.id} className="surface p-4" data-task={t.status}>
        <p className="text-sm font-semibold">{TASK_KINDS[t.kind]} · {listingName(t.listing_id)}</p>
        <p className="text-xs text-muted-foreground">{TASK_STATUSES[t.status]} · {member(t.assignee_id)} · opened {t.opened_at.slice(0, 10)}{t.due_on ? ` · due ${t.due_on}` : ""}{t.resolved_on ? ` · confirmed ${t.resolved_on}` : ""}</p>
        <p className="mt-2 whitespace-pre-wrap text-sm">{t.reason}</p>
        {t.resolution && <p className="mt-2 whitespace-pre-wrap text-sm text-emerald-800" data-resolution>Resolution: {t.resolution}{t.evidence_ref ? ` · ${t.evidence_ref}` : ""}</p>}
        <details className="mt-3 border-t pt-3"><summary className="cursor-pointer text-sm font-medium">Update task</summary>
          <div className="mt-3"><TaskUpdateForm key={t.updated_at} task={t} team={teamOptions} checks={checks.filter((c) => c.listing_id === t.listing_id).map((c) => ({ id: c.id, name: `${c.checked_on} · ${c.result}` }))} /></div></details>
      </article>)}
    </section>

    <section className="space-y-3" id="requests" data-requests>
      <h3 className="text-lg font-semibold">Manual fulfillment requests</h3>
      <p className="text-sm text-muted-foreground">A record of what was asked of a provider, the approved budget, the cash actually paid and prepaid credits used, kept apart. Nothing here places an order.</p>
      <RequestForm clientId={clientId} locationId={locationId} directories={directories} listings={listingOptions} />
      {requests.map((r) => <article key={r.id} className="surface p-4" data-request={r.status}>
        <p className="text-sm font-semibold">{REQUEST_ACTIONS[r.action]} · {dirName.get(r.directory_id) ?? "Directory"} · {PROVIDERS[r.provider as keyof typeof PROVIDERS] ?? r.provider}</p>
        <p className="text-xs text-muted-foreground">{REQUEST_STATUSES[r.status]}{r.approved_at ? ` · approved ${r.approved_at.slice(0, 10)}` : ""}{r.approved_budget !== null ? ` · budget ${r.approved_budget} ${r.budget_currency}` : ""}
          {r.actual_amount !== null ? ` · paid ${r.actual_amount} ${r.actual_currency}` : ""}{r.credits_used !== null ? ` · ${r.credits_used} credits` : ""}{r.provider_reference ? ` · ref ${r.provider_reference}` : ""}</p>
        <details className="mt-3 border-t pt-3"><summary className="cursor-pointer text-sm font-medium">Update request</summary>
          <div className="mt-3"><RequestUpdateForm key={r.updated_at} request={r} isAdmin={role?.role === "admin"} /></div></details>
      </article>)}
    </section>
    </>}
  </div>;
}
