import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { citationsEnabled } from "@/lib/citations-flag";
import { isUuid } from "@/lib/tasks";
import { CitationImport } from "@/components/citations/citation-import";

export const dynamic = "force-dynamic";

export default async function CitationImportPage({ params }: { params: Promise<{ clientId: string }> }) {
  if (!citationsEnabled()) notFound();
  const { clientId } = await params;
  if (!isUuid(clientId)) notFound();
  const db = await createClient();
  const { data: locations, error } = await db.from("citation_locations").select("id, label").eq("client_id", clientId).eq("status", "active").order("label");
  return <div className="space-y-5" data-citation-import>
    <Link href={`/clients/${clientId}/citations`} className="text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">&larr; Citations</Link>
    <div><h2 className="text-xl font-semibold">Import citations from a CSV</h2>
      <p className="text-sm text-muted-foreground">A generic, mapped import. A provider-specific mapping (BrightLocal or another) is added only after a real export has been reviewed.</p></div>
    {error ? <p role="alert" className="callout">Business locations could not be read. Refresh to retry.</p>
      : !locations?.length ? <p className="surface p-6 text-sm">Add this client&apos;s business locations first; every imported row must be placed on one.</p>
      : <CitationImport clientId={clientId} locations={locations.map((l) => ({ id: l.id, name: l.label }))} />}
  </div>;
}
