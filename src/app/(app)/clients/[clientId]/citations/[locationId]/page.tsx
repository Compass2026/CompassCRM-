import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { citationsEnabled } from "@/lib/citations-flag";
import { isUuid } from "@/lib/tasks";
import { getCurrentTeamRole, listTeamMembers } from "@/lib/team";
import { inView, listingView, loadListings, summarize } from "@/lib/citations-data";
import {
  CHECK_METHODS, CHECK_RESULTS, OPEN_TASK_STATUSES, REQUEST_ACTIONS, REQUEST_STATUSES, TASK_KINDS, TASK_STATUSES, compareListing, identityAddress,
  type CitationCheck, type CitationLocation, type CitationLocationIdentity, type CitationRequest, type CitationTask,
} from "@/lib/citations";
import { FieldChip, FreshnessBadge, FulfillmentBadge, PhaseNote, SummaryCards, VerificationBadge, ViewNav } from "@/components/citations/citation-bits";
import { AddListingForm, CheckForm, EditLocationForm, OpenTaskForm, PROVIDERS, RequestForm, RequestUpdateForm, TaskUpdateForm } from "@/components/citations/citation-forms";

export const dynamic = "force-dynamic";

export default async function CitationLocationPage({ params, searchParams }: { params: Promise<{ clientId: string; locationId: string }>; searchParams: Promise<{ view?: string }> }) {
  if (!citationsEnabled()) notFound();
  const { clientId, locationId } = await params;
  if (!isUuid(clientId) || !isUuid(locationId)) notFound();
  const view = listingView((await searchParams).view);
  const db = await createClient();
  const { data: location } = await db.from("citation_locations").select("*").eq("client_id", clientId).eq("id", locationId).maybeSingle();
  if (!location) notFound();
  const loc = location as CitationLocation;
  const [{ listings, error }, tasksQ, requestsQ, historyQ, dirsQ, trackingQ, brandsQ, team, role] = await Promise.all([
    loadListings(db, { clientId, locationId }),
    db.from("citation_tasks").select("*").eq("client_id", clientId).eq("location_id", locationId).order("opened_at", { ascending: false }).limit(300),
    db.from("citation_fulfillment_requests").select("*").eq("client_id", clientId).eq("location_id", locationId).order("created_at", { ascending: false }).limit(200),
    db.from("citation_location_identities").select("*").eq("location_id", locationId).order("version", { ascending: false }).limit(50),
    db.from("citation_directories").select("id, name").eq("is_active", true).order("name"),
    db.from("locations").select("id, name").eq("client_id", clientId).order("sort_order"),
    db.from("client_brand_workspaces").select("id, name").eq("client_id", clientId).order("name"),
    listTeamMembers(db), getCurrentTeamRole(db),
  ]);
  const ids = listings.map((l) => l.id);
  const checksQ = ids.length ? await db.from("citation_checks").select("*").in("listing_id", ids).order("checked_on", { ascending: false }).order("recorded_at", { ascending: false }).limit(3000) : { data: [], error: null };
  const failure = error ?? (tasksQ.error || requestsQ.error || checksQ.error || dirsQ.error ? "Parts of this location could not be read. Refresh to retry." : null);
  const tasks = (tasksQ.data ?? []) as CitationTask[];
  const openTasks = tasks.filter((t) => OPEN_TASK_STATUSES.includes(t.status));
  const requests = (requestsQ.data ?? []) as CitationRequest[];
  const checks = (checksQ.data ?? []) as CitationCheck[];
  const history = (historyQ.data ?? []) as CitationLocationIdentity[];
  const directories = dirsQ.data ?? [];
  const teamOptions = team.map((t) => ({ id: t.id, name: t.name }));
  const dirName = new Map(directories.map((d) => [d.id, d.name]));
  const listingName = (id: string | null) => { const l = listings.find((x) => x.id === id); return l ? `${l.directory_name}${l.listing_url ? ` · ${l.listing_url.replace(/^https?:\/\/(www\.)?/, "")}` : l.external_id ? ` · ${l.external_id}` : ""}` : "Location"; };
  const listingOptions = listings.map((l) => ({ id: l.id, name: listingName(l.id), directory_id: l.directory_id }));
  const visible = listings.filter((l) => inView(l, view));
  const base = `/clients/${clientId}/citations/${locationId}`;
  const member = (id: string | null) => team.find((t) => t.id === id)?.name ?? "Unassigned";

  return <div className="space-y-6" data-citation-location>
    <Link href={`/clients/${clientId}/citations`} className="text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">&larr; All locations</Link>
    <section className="surface space-y-3 p-5" data-identity>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><h2 className="text-xl font-semibold">{loc.label}</h2><p className="text-xs text-muted-foreground">Approved identity v{loc.identity_version} · {loc.approved_at.slice(0, 10)}{loc.status === "archived" ? " · archived" : ""}</p></div>
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
      <details className="border-t pt-3"><summary className="cursor-pointer text-sm font-medium">Identity history ({history.length})</summary>
        <ul className="mt-3 space-y-2 text-xs">{history.map((h) => <li key={h.id} className="border-t pt-2"><p className="font-semibold">v{h.version} · {h.recorded_at.slice(0, 10)} · {h.note || "—"}</p>
          <p className="text-muted-foreground">{h.business_name} · {identityAddress(h) || "no street"}{h.hide_address ? " (hidden)" : ""} · {h.phone || "no phone"} · {h.website_url ?? "no website"}</p></li>)}</ul></details>
    </section>

    <PhaseNote />
    {failure && <p role="alert" className="callout">{failure}</p>}
    <SummaryCards s={summarize(listings, openTasks.length)} />

    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-lg font-semibold">Listings</h3>
        <div className="flex flex-wrap gap-2"><AddListingForm clientId={clientId} locationId={locationId} directories={directories} /><OpenTaskForm clientId={clientId} locationId={locationId} listings={listingOptions} team={teamOptions} /></div></div>
      <ViewNav base={base} view={view} />
      {!visible.length && <p className="surface p-8 text-center text-sm text-muted-foreground">No listings in this view.</p>}
      <div className="space-y-3" data-listings>{visible.map((l) => {
        const history = checks.filter((c) => c.listing_id === l.id);
        const latest = history[0];
        const cmp = compareListing(loc, latest ?? l);
        const listingTasks = openTasks.filter((t) => t.listing_id === l.id);
        return <article key={l.id} className="surface min-w-0 p-4" data-listing={l.directory_name}>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-semibold">{l.directory_name}</h4>
            <VerificationBadge status={l.verification_status} /><FulfillmentBadge status={l.fulfillment_status} /><FreshnessBadge lastCheckedOn={l.last_checked_on} />
            {l.suspected_duplicate && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800" data-duplicate>Suspected duplicate</span>}
            {listingTasks.length > 0 && <span className="text-xs font-medium">{listingTasks.length} open task{listingTasks.length > 1 ? "s" : ""}</span>}
          </div>
          <p className="mt-2 break-all text-sm">{l.listing_url ? <a className="text-blue-700 underline" href={l.listing_url} target="_blank" rel="noreferrer">{l.listing_url}</a> : <span className="text-muted-foreground">No listing URL{l.external_id ? ` · id ${l.external_id}` : ""}</span>}</p>
          <div className="mt-2 flex flex-wrap gap-1">{(["name", "address", "phone", "website"] as const).map((f) => <FieldChip key={f} field={f} value={cmp[f]} />)}
            <span className="text-xs text-muted-foreground">{latest ? `compared from the ${latest.checked_on} check (identity v${latest.identity_version})` : l.last_imported_at ? "compared from the imported observation, not verified" : "nothing observed yet"}</span></div>
          <p className="mt-2 text-xs text-muted-foreground">Source: {l.source_provider ?? "—"}{l.source_observed_on ? ` · observed ${l.source_observed_on}` : ""}{l.last_imported_at ? ` · imported ${l.last_imported_at.slice(0, 10)}` : ""}</p>
          <details className="mt-3 border-t pt-3"><summary className="cursor-pointer text-sm font-medium">Checks &amp; evidence ({history.length})</summary>
            <div className="mt-3 space-y-3"><CheckForm clientId={clientId} listingId={l.id} />
              <ul className="space-y-2 text-xs" data-checks>{history.map((c) => <li key={c.id} className="border-t pt-2"><p className="font-semibold">{c.checked_on} · {CHECK_RESULTS[c.result]} · {CHECK_METHODS[c.method]}</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{c.evidence}{c.evidence_url && <> · <a className="text-blue-700 underline" href={c.evidence_url} target="_blank" rel="noreferrer">evidence</a></>}</p></li>)}</ul></div></details>
          <details className="mt-3 border-t pt-3"><summary className="cursor-pointer text-sm font-medium">Open a task for this listing</summary>
            <div className="mt-3"><OpenTaskForm clientId={clientId} locationId={locationId} listings={listingOptions} team={teamOptions} defaultListing={l.id} /></div></details>
        </article>;
      })}</div>
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
  </div>;
}
