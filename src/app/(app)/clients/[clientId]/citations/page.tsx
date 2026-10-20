import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { citationsEnabled } from "@/lib/citations-flag";
import { isUuid } from "@/lib/tasks";
import { loadListings, loadOpenTasks, summarize } from "@/lib/citations-data";
import { publicAddress, type CitationImport, type CitationLocation } from "@/lib/citations";
import { PhaseNote, SummaryCards } from "@/components/citations/citation-bits";
import { DirectoryForm, NewLocationForm } from "@/components/citations/citation-forms";

export const dynamic = "force-dynamic";

export default async function ClientCitationsPage({ params }: { params: Promise<{ clientId: string }> }) {
  if (!citationsEnabled()) notFound();
  const { clientId } = await params;
  if (!isUuid(clientId)) notFound();
  const db = await createClient();
  const [{ listings, error }, tasksQ, locsQ, trackingQ, brandsQ, importsQ] = await Promise.all([
    loadListings(db, { clientId }), loadOpenTasks(db, { clientId }),
    db.from("citation_locations").select("*").eq("client_id", clientId).order("status").order("label"),
    db.from("locations").select("id, name").eq("client_id", clientId).order("sort_order"),
    db.from("client_brand_workspaces").select("id, name").eq("client_id", clientId).order("name"),
    db.from("citation_imports").select("id, client_id, file_name, file_sha256, provider, mapping, rows_total, added, updated, skipped, rejected, created_at, created_by")
      .eq("client_id", clientId).order("created_at", { ascending: false }).limit(10),
  ]);
  const failure = error ?? (tasksQ.error || locsQ.error || importsQ.error ? "Citations could not be read. Refresh to retry." : null);
  const locations = (locsQ.data ?? []) as CitationLocation[];
  const tasks = tasksQ.data ?? [];
  const imports = (importsQ.data ?? []) as CitationImport[];
  const base = `/clients/${clientId}/citations`;

  return <div className="space-y-6" data-client-citations>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-xl font-semibold">Citations</h2><p className="text-sm text-muted-foreground">Business locations, their directory listings and the evidence behind each status.</p></div>
      <div className="flex flex-wrap gap-2 text-sm">
        <Link className="rounded-full bg-blue-700 px-3 py-2 font-medium text-white" href={`${base}/import`}>Import CSV</Link>
        <a className="rounded-full bg-blue-50 px-3 py-2 font-medium text-blue-800" href={`${base}/export?variant=client`}>Export report (client-safe)</a>
        <a className="rounded-full bg-blue-50 px-3 py-2 font-medium text-blue-800" href={`${base}/export?variant=internal`}>Export (internal)</a>
      </div>
    </div>
    <PhaseNote />
    {failure && <p role="alert" className="callout">{failure}</p>}
    <SummaryCards s={summarize(listings, tasks.length)} />

    <section className="grid gap-4 lg:grid-cols-2" data-locations>
      {locations.map((l) => {
        const s = summarize(listings.filter((x) => x.location_id === l.id), tasks.filter((t) => t.location_id === l.id).length);
        return <Link key={l.id} href={`${base}/${l.id}`} className="surface block p-5 transition-colors hover:bg-royal-50" data-location-card={l.label}>
          <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="font-semibold">{l.label}</h3>
            <span className="text-xs text-muted-foreground">{l.status === "archived" ? "Archived · " : ""}identity v{l.identity_version}</span></div>
          <p className="mt-1 text-sm">{l.business_name}</p>
          <p className="text-sm text-muted-foreground">{publicAddress(l)}{l.phone ? ` · ${l.phone}` : ""}</p>
          <p className="mt-3 text-xs text-muted-foreground">{s.total} listings · {s.byVerification.verified_accurate} verified · {s.byVerification.discrepancy} discrepancies · {s.openTasks} open tasks · <span className="font-semibold text-foreground">{s.action} need action</span></p>
        </Link>;
      })}
      {!locations.length && !failure && <p className="surface p-8 text-center text-sm text-muted-foreground lg:col-span-2">No business locations yet. Add the approved identity of each real, listing-eligible location first.</p>}
    </section>

    <NewLocationForm clientId={clientId} trackingLocations={(trackingQ.data ?? []).map((l) => ({ id: l.id, name: l.name }))} brands={brandsQ.data ?? []} />

    <section className="surface space-y-3 p-5" data-imports>
      <h3 className="font-semibold">Recent imports</h3>
      {imports.length ? <table className="w-full text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th>When</th><th>File</th><th>Source</th><th>Rows</th><th>Added</th><th>Updated</th><th>Skipped</th><th>Rejected</th></tr></thead>
        <tbody>{imports.map((i) => <tr key={i.id} className="border-t"><td className="py-1">{i.created_at.slice(0, 16).replace("T", " ")}</td><td className="break-all">{i.file_name}</td><td>{i.provider}</td>
          <td>{i.rows_total}</td><td>{i.added}</td><td>{i.updated}</td><td>{i.skipped}</td><td>{i.rejected}</td></tr>)}</tbody></table>
        : <p className="text-sm text-muted-foreground">No imports yet.</p>}
    </section>

    <section className="surface space-y-3 p-5"><h3 className="font-semibold">Directory registry</h3>
      <p className="text-sm text-muted-foreground">Shared by every client. Add a directory before listing it, or let an import add unknown ones.</p>
      <DirectoryForm clientId={clientId} /></section>
  </div>;
}
