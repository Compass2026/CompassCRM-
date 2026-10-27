import { createClient } from "@/lib/supabase/server";
import { reviewCoreKeywordList } from "@/app/core-keyword-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Keyword = { id: string; keyword: string; intent: string | null; is_money: boolean; priority: string | null };

type CoreListRow = {
  id: string; version: number; status: string; keyword_ids: string[]; source_ref: string; proposed_at: string; approved_at: string | null;
};

function CoreList({ clientId, byId, list, label }: { clientId: string; byId: Map<string, Keyword>; list: CoreListRow; label: string }) {
  const ks = list.keyword_ids.map((id) => byId.get(id)).filter((k): k is Keyword => !!k);
  const noIntent = ks.filter((k) => !k.intent).length;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={list.status === "approved" ? "default" : "secondary"}>{label} v{list.version}</Badge>
        <span>{list.keyword_ids.length} keywords</span>
        {noIntent > 0 && <span className="text-amber-700">{noIntent} without an intent (not usable until set)</span>}
        <span className="text-xs text-muted-foreground">
          {list.status === "approved" && list.approved_at ? `approved ${list.approved_at.slice(0, 10)}` : `proposed ${list.proposed_at.slice(0, 10)}`}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">Source: {list.source_ref}</p>
      <div className="flex flex-wrap gap-1">
        {ks.map((k) => (
          <span key={k.id} className="rounded border px-1.5 py-0.5 text-xs">
            {k.keyword}
            {k.is_money ? " · money" : ""}
            {k.intent ? ` · ${k.intent}` : ""}
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        {list.status === "proposed" && (
          <form action={reviewCoreKeywordList.bind(null, clientId, list.id, list.version, "approve")}>
            <Button type="submit" size="sm">Approve v{list.version}</Button>
          </form>
        )}
        <form action={reviewCoreKeywordList.bind(null, clientId, list.id, list.version, "withdraw")}>
          <Button type="submit" size="sm" variant="outline">
            {list.status === "approved" ? `Revoke v${list.version}` : `Withdraw v${list.version}`}
          </Button>
        </form>
      </div>
    </div>
  );
}

// The client's core keyword lists (20261027160000): one per site program —
// the client for a single-site client, each brand site for a multi-brand one
// (BHG: Safety, Forklift, Heavy Equipment). Each site's approved version is
// what its weekly blog, Facebook and Business Profile drafts must trace to;
// a proposal waits for a teammate. Locations are not lists.
export async function CoreKeywordListCard({ clientId, keywords }: { clientId: string; keywords: Keyword[] }) {
  const supabase = await createClient();
  const [{ data: lists }, { data: sites }] = await Promise.all([
    supabase
      .from("core_keyword_lists")
      .select("id, version, status, keyword_ids, source_ref, proposed_at, approved_at, brand_workspace_id")
      .eq("client_id", clientId)
      .in("status", ["approved", "proposed"])
      .order("version", { ascending: false }),
    supabase.from("client_brand_workspaces").select("id, name").eq("client_id", clientId).order("name"),
  ]);
  const byId = new Map(keywords.map((k) => [k.id, k]));
  const programs: { id: string | null; name: string | null }[] = (sites ?? []).length
    ? (sites ?? []).map((w) => ({ id: w.id, name: w.name }))
    : [{ id: null, name: null }];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Core keyword list{programs.length > 1 ? "s" : ""}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">
          Every weekly blog, Facebook and Business Profile draft must use a keyword from its site&apos;s approved list, or a
          long-tail keyword linked to one. Without an approved list, nothing is drafted for that site.
        </p>
        {programs.map((program) => {
          const mine = (lists ?? []).filter((l) => (l.brand_workspace_id ?? null) === program.id);
          const approved = mine.find((l) => l.status === "approved") ?? null;
          const proposal = mine.find((l) => l.status === "proposed" && (!approved || l.version > approved.version)) ?? null;
          return (
            <div key={program.id ?? "client"} className="space-y-3">
              {program.name && <h3 className="text-sm font-semibold">{program.name}</h3>}
              {approved ? <CoreList clientId={clientId} byId={byId} list={approved} label="Approved" /> : <p className="text-sm">No approved list.</p>}
              {proposal && <CoreList clientId={clientId} byId={byId} list={proposal} label="Proposed" />}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
