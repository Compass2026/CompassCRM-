import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  addServiceAction,
  approveAllProposedAction,
  deleteServiceAction,
  moveServiceAction,
  setServiceStatusAction,
  updateServiceAction,
} from "@/app/service-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  stageStatusLabels,
  stageStatusStyles,
  taxonomyStatusLabels,
  taxonomyStatusStyles,
} from "@/lib/labels";
import { cn } from "@/lib/utils";

const selectClass =
  "field-sm";

const UNSEGMENTED = "Unsegmented";

export default async function ServicesPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await createClient();

  const [{ data: services }, { data: keywords }, { data: pageGroups }] =
    await Promise.all([
      supabase
        .from("services")
        .select("*")
        .eq("client_id", clientId)
        .order("sort_order")
        .order("name"),
      supabase
        .from("keywords")
        .select("id, keyword, service_id, is_money, priority")
        .eq("client_id", clientId)
        .order("keyword"),
      supabase
        .from("page_groups")
        .select("id, name, page_type, target_url, status")
        .eq("client_id", clientId),
    ]);

  const all = services ?? [];
  const keywordById = new Map((keywords ?? []).map((k) => [k.id, k]));

  // Keywords hung off each service via keywords.service_id.
  const keywordsByService = new Map<string, number>();
  for (const k of keywords ?? []) {
    if (!k.service_id) continue;
    keywordsByService.set(
      k.service_id,
      (keywordsByService.get(k.service_id) ?? 0) + 1
    );
  }

  const childrenOf = new Map<string, typeof all>();
  for (const s of all) {
    if (!s.parent_service_id) continue;
    const list = childrenOf.get(s.parent_service_id) ?? [];
    list.push(s);
    childrenOf.set(s.parent_service_id, list);
  }

  // Top-level services grouped by segment, segments ordered by their first
  // service's sort_order so the taxonomy reads in the order it was built.
  const roots = all.filter((s) => !s.parent_service_id);
  const segments: { name: string; services: typeof all }[] = [];
  for (const s of roots) {
    const name = s.segment ?? UNSEGMENTED;
    const existing = segments.find((g) => g.name === name);
    if (existing) existing.services.push(s);
    else segments.push({ name, services: [s] });
  }

  const counts = {
    total: all.length,
    approved: all.filter((s) => s.status === "approved").length,
    proposed: all.filter((s) => s.status === "proposed").length,
    retired: all.filter((s) => s.status === "retired").length,
    folded: all.filter((s) => s.parent_service_id).length,
    unmapped: roots.filter((s) => !s.primary_keyword_id).length,
    noPage: roots.filter((s) => !s.page_url).length,
  };

  // Foundation stage 1 — the taxonomy gate. Approving services here does not
  // move the stage; the Pipelines tab does that.
  const { data: clientStages } = await supabase
    .from("client_stages")
    .select(
      "status, client_pipelines!inner(client_id, pipelines(key)), stages(sort_order)"
    )
    .eq("client_pipelines.client_id", clientId);

  const foundationStage = (clientStages ?? []).find(
    (cs) =>
      cs.client_pipelines?.pipelines?.key === "foundation" &&
      cs.stages?.sort_order === 1
  );

  const segmentNames = [
    ...new Set(all.map((s) => s.segment).filter((s): s is string => !!s)),
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 border rounded-md bg-card px-3 py-2 flex-wrap">
        <span className="text-sm font-medium">
          {counts.total} service{counts.total === 1 ? "" : "s"}
        </span>
        <span className="text-xs text-muted-foreground">
          {counts.approved} approved
          {counts.proposed > 0 && ` · ${counts.proposed} proposed`}
          {counts.retired > 0 && ` · ${counts.retired} retired`}
          {counts.folded > 0 && ` · ${counts.folded} folded`}
        </span>
        {foundationStage && (
          <Link
            href={`/clients/${clientId}/pipelines`}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Foundation › Onboarding &amp; Service Taxonomy
            <Badge
              variant="outline"
              className={cn("text-xs", stageStatusStyles[foundationStage.status])}
            >
              {stageStatusLabels[foundationStage.status]}
            </Badge>
          </Link>
        )}
        {counts.proposed > 0 && (
          <form
            action={approveAllProposedAction.bind(null, clientId)}
            className="ml-auto"
          >
            <Button type="submit" size="sm">
              Approve all {counts.proposed} proposed
            </Button>
          </form>
        )}
      </div>

      {counts.total > 0 && (counts.unmapped > 0 || counts.noPage > 0) && (
        <div className="border rounded-md bg-amber-50 border-amber-200 px-3 py-2 text-xs text-amber-900">
          {counts.noPage > 0 && (
            <span>
              {counts.noPage} service{counts.noPage === 1 ? " has" : "s have"} no
              page URL.{" "}
            </span>
          )}
          {counts.unmapped > 0 && (
            <span>
              {counts.unmapped} service{counts.unmapped === 1 ? " has" : "s have"}{" "}
              no primary keyword — PB4a audits against the keyword map, so these
              won&apos;t be checked.
            </span>
          )}
        </div>
      )}

      {segments.map((segment) => (
        <Card key={segment.name}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {segment.name}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {segment.services.length} service
                {segment.services.length === 1 ? "" : "s"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {segment.services.map((s) => {
              const children = childrenOf.get(s.id) ?? [];
              const primary = s.primary_keyword_id
                ? keywordById.get(s.primary_keyword_id)
                : null;
              return (
                <div key={s.id} className="border-b last:border-0 pb-1">
                  <details className="group">
                    <summary className="flex items-center gap-2 py-1.5 cursor-pointer list-none [&::-webkit-details-marker]:hidden hover:bg-muted/40 rounded px-1 -mx-1">
                      <span className="text-muted-foreground text-xs w-4 shrink-0 group-open:rotate-90 transition-transform">
                        ›
                      </span>
                      <span className="font-medium text-sm flex-1 min-w-0 truncate">
                        {s.name}
                      </span>
                      {s.page_type === "hub" && (
                        <Badge variant="outline" className="text-xs">
                          Hub
                        </Badge>
                      )}
                      {children.length > 0 && (
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          +{children.length} folded
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground truncate max-w-48 hidden sm:inline">
                        {s.page_url ?? "— no page —"}
                      </span>
                      <span className="text-xs text-muted-foreground truncate max-w-56 hidden md:inline">
                        {primary ? primary.keyword : "— no primary keyword —"}
                      </span>
                      {(keywordsByService.get(s.id) ?? 0) > 0 && (
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {keywordsByService.get(s.id)} kw
                        </span>
                      )}
                      <Badge
                        variant="outline"
                        className={cn("text-xs", taxonomyStatusStyles[s.status])}
                      >
                        {taxonomyStatusLabels[s.status]}
                      </Badge>
                    </summary>

                    <div className="pl-6 pb-2 space-y-2">
                      <form
                        action={updateServiceAction.bind(null, clientId, s.id)}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <Input
                          name="name"
                          defaultValue={s.name}
                          required
                          className="h-8 text-xs min-w-48 flex-1"
                        />
                        <Input
                          name="segment"
                          defaultValue={s.segment ?? ""}
                          placeholder="Segment"
                          list="segments"
                          className="h-8 text-xs w-40"
                        />
                        <Input
                          name="page_url"
                          defaultValue={s.page_url ?? ""}
                          placeholder="/page-url"
                          className="h-8 text-xs w-44"
                        />
                        <Input
                          name="gbp_entry"
                          defaultValue={s.gbp_entry ?? ""}
                          placeholder="GBP services entry"
                          className="h-8 text-xs w-48"
                        />
                        <select
                          name="page_type"
                          defaultValue={s.page_type}
                          className={selectClass}
                        >
                          <option value="service">Service page</option>
                          <option value="hub">Hub page</option>
                        </select>
                        <select
                          name="primary_keyword_id"
                          defaultValue={s.primary_keyword_id ?? ""}
                          className={cn(selectClass, "max-w-56")}
                        >
                          <option value="">— primary keyword —</option>
                          {(keywords ?? []).map((k) => (
                            <option key={k.id} value={k.id}>
                              {k.keyword}
                              {k.is_money ? " ★" : ""}
                            </option>
                          ))}
                        </select>
                        <select
                          name="parent_service_id"
                          defaultValue={s.parent_service_id ?? ""}
                          className={cn(selectClass, "max-w-56")}
                          disabled={children.length > 0}
                        >
                          <option value="">— its own page —</option>
                          {roots
                            .filter((r) => r.id !== s.id)
                            .map((r) => (
                              <option key={r.id} value={r.id}>
                                folded into {r.name}
                              </option>
                            ))}
                        </select>
                        <select
                          name="status"
                          defaultValue={s.status}
                          className={selectClass}
                        >
                          <option value="proposed">Proposed</option>
                          <option value="approved">Approved</option>
                          <option value="retired">Retired</option>
                        </select>
                        <Button type="submit" size="sm">
                          Save
                        </Button>
                      </form>

                      <div className="flex items-center gap-1 flex-wrap">
                        {s.status !== "approved" && (
                          <form
                            action={setServiceStatusAction.bind(
                              null,
                              clientId,
                              s.id,
                              "approved"
                            )}
                          >
                            <Button type="submit" size="sm" variant="outline">
                              Approve
                            </Button>
                          </form>
                        )}
                        {s.status !== "retired" && (
                          <form
                            action={setServiceStatusAction.bind(
                              null,
                              clientId,
                              s.id,
                              "retired"
                            )}
                          >
                            <Button type="submit" size="sm" variant="ghost">
                              Retire
                            </Button>
                          </form>
                        )}
                        <form
                          action={moveServiceAction.bind(
                            null,
                            clientId,
                            s.id,
                            "up"
                          )}
                        >
                          <Button type="submit" size="sm" variant="ghost">
                            ↑
                          </Button>
                        </form>
                        <form
                          action={moveServiceAction.bind(
                            null,
                            clientId,
                            s.id,
                            "down"
                          )}
                        >
                          <Button type="submit" size="sm" variant="ghost">
                            ↓
                          </Button>
                        </form>
                        <form
                          action={deleteServiceAction.bind(null, clientId, s.id)}
                          className="ml-auto"
                        >
                          <Button type="submit" size="sm" variant="ghost">
                            ✕ Delete
                          </Button>
                        </form>
                      </div>

                      {children.length > 0 && (
                        <div className="border-l-2 pl-3 space-y-1">
                          <p className="text-xs text-muted-foreground">
                            Folded into this page — no page of their own:
                          </p>
                          {children.map((c) => (
                            <div
                              key={c.id}
                              className="flex items-center gap-2 text-xs"
                            >
                              <span className="flex-1 truncate">{c.name}</span>
                              <span className="text-muted-foreground truncate max-w-40">
                                {c.page_url ?? "—"}
                              </span>
                              <Badge
                                variant="outline"
                                className={cn(
                                  "text-xs",
                                  taxonomyStatusStyles[c.status]
                                )}
                              >
                                {taxonomyStatusLabels[c.status]}
                              </Badge>
                              <form
                                action={updateServiceAction.bind(
                                  null,
                                  clientId,
                                  c.id
                                )}
                              >
                                {/* Carry every field the update action reads —
                                    an omitted field is written as null. */}
                                <input type="hidden" name="name" value={c.name} />
                                <input
                                  type="hidden"
                                  name="segment"
                                  value={c.segment ?? ""}
                                />
                                <input
                                  type="hidden"
                                  name="page_url"
                                  value={c.page_url ?? ""}
                                />
                                <input
                                  type="hidden"
                                  name="gbp_entry"
                                  value={c.gbp_entry ?? ""}
                                />
                                <input
                                  type="hidden"
                                  name="page_type"
                                  value={c.page_type}
                                />
                                <input
                                  type="hidden"
                                  name="primary_keyword_id"
                                  value={c.primary_keyword_id ?? ""}
                                />
                                <input
                                  type="hidden"
                                  name="status"
                                  value={c.status}
                                />
                                <input
                                  type="hidden"
                                  name="parent_service_id"
                                  value=""
                                />
                                <Button type="submit" size="sm" variant="ghost">
                                  Unfold
                                </Button>
                              </form>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </details>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}

      {counts.total === 0 && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">
              No taxonomy yet for this client.
            </p>
            <p className="text-xs">
              The service taxonomy is PB1 — the first Foundation stage. Every
              other playbook reads it: page groups, the keyword map, the GBP
              services list, and the PB4a audit. Add the services below, then
              approve.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Add a service</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={addServiceAction.bind(null, clientId)} className="flex flex-wrap gap-2">
            <Input
              name="name"
              placeholder="Service name"
              required
              className="h-8 flex-1 min-w-48"
            />
            <Input
              name="segment"
              placeholder="Segment"
              list="segments"
              className="h-8 w-40"
            />
            <Input name="page_url" placeholder="/page-url" className="h-8 w-44" />
            <Input
              name="gbp_entry"
              placeholder="GBP services entry"
              className="h-8 w-48"
            />
            <select name="page_type" defaultValue="service" className={selectClass}>
              <option value="service">Service page</option>
              <option value="hub">Hub page</option>
            </select>
            <select name="primary_keyword_id" defaultValue="" className={cn(selectClass, "max-w-56")}>
              <option value="">— primary keyword —</option>
              {(keywords ?? []).map((k) => (
                <option key={k.id} value={k.id}>
                  {k.keyword}
                  {k.is_money ? " ★" : ""}
                </option>
              ))}
            </select>
            <select name="parent_service_id" defaultValue="" className={cn(selectClass, "max-w-56")}>
              <option value="">— its own page —</option>
              {roots.map((r) => (
                <option key={r.id} value={r.id}>
                  folded into {r.name}
                </option>
              ))}
            </select>
            <Button type="submit" size="sm">
              Add service
            </Button>
          </form>
          <datalist id="segments">
            {segmentNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </CardContent>
      </Card>

      {(pageGroups ?? []).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Page groups
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {(pageGroups ?? []).length} planned pages built from this
                taxonomy
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-2">
              Read-only here — the sitemap plan gets its own editor in a later
              step.
            </p>
            <div className="space-y-1">
              {(pageGroups ?? []).map((g) => (
                <div key={g.id} className="flex items-center gap-2 text-sm">
                  <Badge variant="outline" className="text-xs shrink-0">
                    {g.page_type}
                  </Badge>
                  <span className="flex-1 truncate">{g.name}</span>
                  <span className="text-xs text-muted-foreground truncate max-w-56">
                    {g.target_url ?? "—"}
                  </span>
                  <Badge
                    variant="outline"
                    className={cn("text-xs", taxonomyStatusStyles[g.status])}
                  >
                    {taxonomyStatusLabels[g.status]}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
