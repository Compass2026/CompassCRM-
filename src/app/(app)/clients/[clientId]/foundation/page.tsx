import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  addClaimAction,
  addMoneyKeywordAction,
  addPaletteColorAction,
  approveBrandBoardAction,
  confirmMoneyKeywordAction,
  createBrandBoardAction,
  deleteClaimAction,
  removeMoneyKeywordAction,
  removePaletteColorAction,
  reopenBrandBoardAction,
  setClaimStatusAction,
  setFoundationStageAction,
  setTypographyAction,
  unconfirmMoneyKeywordAction,
  updateBrandBoardAction,
  updateMoneyThresholdsAction,
} from "@/app/foundation-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  brandBoardStatusStyles,
  claimStatusLabels,
  claimStatusStyles,
  stageStatusLabels,
  stageStatusStyles,
  type ClaimStatus,
  type StageStatus,
} from "@/lib/labels";
import {
  driveFolderLinks,
  paletteContrast,
  paletteEntries,
  paletteIsEditable,
  paletteRules,
  typographyEntries,
  typographyField,
  typographyIsSimple,
  typographyNotes,
} from "@/lib/brand-board";
import { cn } from "@/lib/utils";

const selectClass =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs";

const claimStatuses: ClaimStatus[] = ["sourced", "unverified", "confirmed"];

function money(n: number | null): string {
  return n == null ? "—" : `$${n.toFixed(2)}`;
}

export default async function FoundationPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await createClient();

  const [
    { data: client },
    { data: enrollments },
    { data: board },
    { data: claims },
    { data: keywords },
    { data: moneyKeywords },
    { data: services },
    { count: pageGroupCount },
  ] = await Promise.all([
    supabase
      .from("clients")
      .select("name, drive_folders, drive_root_url, vertical, business_type")
      .eq("id", clientId)
      .single(),
    supabase
      .from("client_pipelines")
      .select(
        `id, status, pipelines!inner(key),
         client_stages(
           id, status, evidence, next_action, completed_at,
           stages(name, sort_order, description, playbook_ref),
           deliverables(id, label, url)
         )`
      )
      .eq("client_id", clientId)
      .eq("pipelines.key", "foundation")
      .maybeSingle(),
    supabase
      .from("brand_boards")
      .select("*")
      .eq("client_id", clientId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("claims")
      .select("*")
      .eq("client_id", clientId)
      .order("status")
      .order("created_at"),
    supabase
      .from("keywords")
      .select(
        "id, keyword, priority, volume, cpc, competition, intent, city, is_tracked, is_money, is_active, target_url"
      )
      .eq("client_id", clientId)
      .order("is_money", { ascending: false })
      .order("volume", { ascending: false, nullsFirst: false })
      .order("keyword"),
    supabase
      .from("money_keywords")
      .select("*, keywords(keyword, city)")
      .eq("client_id", clientId)
      .order("created_at"),
    supabase
      .from("services")
      .select("id, status")
      .eq("client_id", clientId),
    supabase
      .from("page_groups")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId),
  ]);

  const stages = [...(enrollments?.client_stages ?? [])].sort(
    (a, b) => (a.stages?.sort_order ?? 0) - (b.stages?.sort_order ?? 0)
  );
  const folders = driveFolderLinks(client?.drive_folders ?? null);
  const serviceCounts = {
    total: services?.length ?? 0,
    approved: (services ?? []).filter((s) => s.status === "approved").length,
    proposed: (services ?? []).filter((s) => s.status === "proposed").length,
  };
  const palette = board ? paletteEntries(board.palette) : [];
  const paletteEditable = board ? paletteIsEditable(board.palette) : false;
  const typography = board ? typographyEntries(board.typography) : [];
  const typographySimple = board ? typographyIsSimple(board.typography) : false;
  const moneyIds = new Set((moneyKeywords ?? []).map((m) => m.keyword_id));
  const candidates = (keywords ?? []).filter((k) => !moneyIds.has(k.id) && k.is_active);
  const claimsByStatus = claimStatuses.map((status) => ({
    status,
    rows: (claims ?? []).filter((c) => c.status === status),
  }));

  return (
    <div className="space-y-4">
      {/* ── Header: enrollment, stages, Drive folders ─────────────────── */}
      <div className="flex items-center gap-3 border rounded-md bg-card px-3 py-2 flex-wrap text-sm">
        <span className="font-medium">Foundation</span>
        {enrollments ? (
          <Badge
            variant="outline"
            className={cn(
              enrollments.status === "complete"
                ? "bg-green-100 text-green-800 border-green-200"
                : "bg-blue-100 text-blue-800 border-blue-200"
            )}
          >
            {enrollments.status}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">
            Not enrolled — every client should be; enroll from the Plan tab.
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {client?.vertical ? `${client.vertical} · ` : ""}
          {client?.business_type ? client.business_type.replace("_", " ") : "business type unset"}
        </span>
        <div className="ml-auto flex items-center gap-1 flex-wrap">
          {folders.length > 0 ? (
            folders.map((f) => (
              <a
                key={f.name}
                href={f.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs border rounded-md px-2 py-0.5 bg-muted/40 hover:bg-muted"
              >
                📁 {f.name}
              </a>
            ))
          ) : client?.drive_root_url ? (
            <a
              href={client.drive_root_url}
              target="_blank"
              rel="noreferrer"
              className="text-xs border rounded-md px-2 py-0.5 bg-muted/40 hover:bg-muted"
            >
              📁 Client folder (01–05 not created yet)
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">No Drive folder recorded</span>
          )}
        </div>
      </div>

      {/* ── Stages ────────────────────────────────────────────────────── */}
      {stages.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-3">
          {stages.map((cs) => (
            <Card key={cs.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm">
                    {cs.stages?.sort_order}. {cs.stages?.name}
                    {cs.stages?.playbook_ref && (
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        {cs.stages.playbook_ref}
                      </span>
                    )}
                  </CardTitle>
                  <Badge variant="outline" className={cn("text-xs", stageStatusStyles[cs.status])}>
                    {stageStatusLabels[cs.status]}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {cs.stages?.sort_order === 1 && (
                  <p className="text-xs">
                    <Link href={`/clients/${clientId}/services`} className="hover:underline text-primary">
                      Services tab
                    </Link>
                    : {serviceCounts.total} services, {serviceCounts.approved} approved
                    {serviceCounts.proposed > 0 && `, ${serviceCounts.proposed} proposed`}
                    {pageGroupCount != null && ` · ${pageGroupCount} page groups`}
                  </p>
                )}
                {cs.evidence ? (
                  <p className="text-xs">
                    <span className="text-muted-foreground">Evidence: </span>
                    {cs.evidence}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">No evidence recorded.</p>
                )}
                {cs.next_action && (
                  <p className="text-xs">
                    <span className="text-muted-foreground">Next: </span>
                    {cs.next_action}
                  </p>
                )}
                {cs.deliverables.length > 0 && (
                  <ul className="text-xs space-y-0.5">
                    {cs.deliverables.map((d) => (
                      <li key={d.id}>
                        <a href={d.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                          {d.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                    Update stage
                  </summary>
                  <form
                    action={setFoundationStageAction.bind(null, clientId)}
                    className="mt-2 space-y-2"
                  >
                    <input type="hidden" name="client_stage_id" value={cs.id} />
                    <select name="status" defaultValue={cs.status} className={cn(selectClass, "w-full")}>
                      {(Object.keys(stageStatusLabels) as StageStatus[]).map((s) => (
                        <option key={s} value={s}>
                          {stageStatusLabels[s]}
                        </option>
                      ))}
                    </select>
                    <Textarea name="evidence" rows={3} defaultValue={cs.evidence ?? ""} placeholder="Evidence: link or note proving the gate is met" />
                    <Input name="next_action" defaultValue={cs.next_action ?? ""} placeholder="Next action" className="h-8 text-xs" />
                    <Button type="submit" size="sm" variant="outline">
                      Save
                    </Button>
                    <p className="text-[11px] text-muted-foreground">
                      Gates are enforced in the database: stages 2–3 wait for the taxonomy stage.
                    </p>
                  </form>
                </details>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {/* ── Brand board ───────────────────────────────────────────── */}
        <Card className="xl:col-span-2">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-base">Brand board</CardTitle>
              {board && (
                <>
                  <Badge variant="outline" className={brandBoardStatusStyles[board.status]}>
                    v{board.version} · {board.status}
                  </Badge>
                  {board.approved_on && (
                    <span className="text-xs text-muted-foreground">
                      approved by {board.approved_by ?? "—"} on {board.approved_on.slice(0, 10)}
                    </span>
                  )}
                  {board.drive_doc_url && (
                    <a href={board.drive_doc_url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
                      Drive doc
                    </a>
                  )}
                </>
              )}
              <div className="ml-auto">
                {board && board.status === "draft" && (
                  <form
                    action={approveBrandBoardAction.bind(null, clientId, board.id)}
                    className="flex items-center gap-3"
                  >
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <input type="checkbox" name="complete_stage" defaultChecked />
                      also mark Brand Build complete
                    </label>
                    <Button type="submit" size="sm">
                      Approve v{board.version}
                    </Button>
                  </form>
                )}
                {board && board.status === "approved" && (
                  <form action={reopenBrandBoardAction.bind(null, clientId, board.id)}>
                    <Button type="submit" size="sm" variant="outline">
                      Reopen as draft
                    </Button>
                  </form>
                )}
                {!board && (
                  <form action={createBrandBoardAction.bind(null, clientId)}>
                    <Button type="submit" size="sm" variant="outline">
                      Start brand board
                    </Button>
                  </form>
                )}
              </div>
            </div>
          </CardHeader>
          {board && (
            <CardContent className="grid gap-6 lg:grid-cols-2 text-sm">
              <div className="space-y-4">
                <div>
                  <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                    Positioning
                  </h3>
                  <p className="font-heading">{board.positioning_line ?? <span className="text-muted-foreground">Not set</span>}</p>
                </div>
                <div>
                  <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                    Standing CTA
                  </h3>
                  <p>{board.standing_cta ?? <span className="text-muted-foreground">Not set</span>}</p>
                </div>
                <div>
                  <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                    Hard rules
                  </h3>
                  {board.hard_rules.length === 0 ? (
                    <p className="text-muted-foreground">None recorded.</p>
                  ) : (
                    <ul className="list-disc pl-5 space-y-0.5 text-xs">
                      {board.hard_rules.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                    Edit positioning, CTA, rules, doc link
                  </summary>
                  <form
                    action={updateBrandBoardAction.bind(null, clientId, board.id)}
                    className="mt-2 space-y-2"
                  >
                    <Textarea name="positioning_line" rows={2} defaultValue={board.positioning_line ?? ""} placeholder="One-line position" />
                    <Input name="standing_cta" defaultValue={board.standing_cta ?? ""} placeholder="Standing CTA" className="h-8 text-xs" />
                    <Textarea name="hard_rules" rows={6} defaultValue={board.hard_rules.join("\n")} placeholder="One rule per line" />
                    <Input name="drive_doc_url" defaultValue={board.drive_doc_url ?? ""} placeholder="Drive doc URL" className="h-8 text-xs" />
                    <Button type="submit" size="sm" variant="outline">
                      Save
                    </Button>
                  </form>
                </details>
              </div>

              <div className="space-y-4">
                <div>
                  <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                    Palette
                  </h3>
                  {palette.length === 0 ? (
                    <p className="text-muted-foreground">No colors yet.</p>
                  ) : (
                    <ul className="grid grid-cols-2 gap-2">
                      {palette.map((p, i) => (
                        <li key={`${p.hex}-${i}`} className="flex items-center gap-2 border rounded-md p-1.5">
                          <span
                            className="size-8 rounded-md border shrink-0"
                            style={{ backgroundColor: p.hex }}
                            aria-hidden
                          />
                          <div className="min-w-0 flex-1 text-xs">
                            <div className="font-medium truncate">
                              {p.name}
                              {p.role && p.role !== p.name && (
                                <span className="text-muted-foreground"> · {p.role}</span>
                              )}
                            </div>
                            <div className="text-muted-foreground font-mono">{p.hex}</div>
                            {p.usage && <div className="text-muted-foreground truncate">{p.usage}</div>}
                          </div>
                          {p.source && (
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px]",
                                p.source === "derived"
                                  ? "bg-zinc-100 text-zinc-600 border-zinc-200"
                                  : "bg-blue-100 text-blue-800 border-blue-200"
                              )}
                            >
                              {p.source}
                            </Badge>
                          )}
                          {paletteEditable && (
                            <form action={removePaletteColorAction.bind(null, clientId, board.id, i)}>
                              <Button type="submit" variant="ghost" size="xs">✕</Button>
                            </form>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {paletteRules(board.palette).length > 0 && (
                    <ul className="mt-2 list-disc pl-5 text-xs space-y-0.5">
                      {paletteRules(board.palette).map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}
                  {paletteContrast(board.palette).length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                        Contrast checks
                      </summary>
                      <ul className="mt-1 text-xs grid grid-cols-2 gap-x-4">
                        {paletteContrast(board.palette).map(([k, v]) => (
                          <li key={k} className="flex justify-between gap-2">
                            <span className="text-muted-foreground">{k}</span>
                            <span className="font-mono">{v}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {paletteEditable ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                        Add color
                      </summary>
                      <form
                        action={addPaletteColorAction.bind(null, clientId, board.id)}
                        className="mt-2 grid grid-cols-2 gap-2"
                      >
                        <Input name="name" placeholder="Name (e.g. Brick)" required className="h-8 text-xs" />
                        <Input name="hex" placeholder="#b5542a" required pattern="#[0-9a-fA-F]{6}" className="h-8 text-xs font-mono" />
                        <Input name="role" placeholder="Role (primary, accent, text…)" className="h-8 text-xs" />
                        <select name="source" defaultValue="sourced" className={selectClass}>
                          <option value="sourced">sourced</option>
                          <option value="derived">derived</option>
                        </select>
                        <Input name="usage" placeholder="Where it is used" className="h-8 text-xs col-span-2" />
                        <Button type="submit" size="sm" variant="outline" className="col-span-2">
                          Add color
                        </Button>
                      </form>
                    </details>
                  ) : (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Stored in the structured shape from the site repo; edit in DESIGN.md / the brand doc.
                    </p>
                  )}
                </div>

                <div>
                  <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                    Typography
                  </h3>
                  {typography.length === 0 ? (
                    <p className="text-muted-foreground">Not set.</p>
                  ) : (
                    <ul className="text-xs space-y-1">
                      {typography.map((t) => (
                        <li key={t.role}>
                          <span className="text-muted-foreground capitalize">{t.role}: </span>
                          <span className="font-medium">{t.family}</span>
                          {t.details && <span className="text-muted-foreground"> — {t.details}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {typographyNotes(board.typography).map((n, i) => (
                    <p key={i} className="text-[11px] text-muted-foreground mt-1">{n}</p>
                  ))}
                  {typographySimple && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                        Edit typography
                      </summary>
                      <form
                        action={setTypographyAction.bind(null, clientId, board.id)}
                        className="mt-2 grid grid-cols-3 gap-2"
                      >
                        <Input name="heading" defaultValue={typographyField(board.typography, "heading")} placeholder="Heading face" className="h-8 text-xs" />
                        <Input name="body" defaultValue={typographyField(board.typography, "body")} placeholder="Body face" className="h-8 text-xs" />
                        <Input name="accent" defaultValue={typographyField(board.typography, "accent")} placeholder="Accent face" className="h-8 text-xs" />
                        <Input name="notes" defaultValue={typographyField(board.typography, "notes")} placeholder="Notes" className="h-8 text-xs col-span-3" />
                        <Button type="submit" size="sm" variant="outline" className="col-span-3">
                          Save typography
                        </Button>
                      </form>
                    </details>
                  )}
                </div>
              </div>
            </CardContent>
          )}
          {!board && (
            <CardContent>
              <p className="text-sm text-muted-foreground">
                No brand board yet. PB2 produces one; start it here or load it from the brand doc.
              </p>
            </CardContent>
          )}
        </Card>

        {/* ── Claims ────────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Claims
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                sourced from the client&apos;s own material · unverified until confirmed in writing
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {claimsByStatus.map(({ status, rows }) => (
              <div key={status}>
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="outline" className={cn("text-xs", claimStatusStyles[status])}>
                    {claimStatusLabels[status]}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{rows.length}</span>
                </div>
                {rows.length === 0 ? (
                  <p className="text-xs text-muted-foreground">None.</p>
                ) : (
                  <ul className="space-y-1">
                    {rows.map((c) => (
                      <li key={c.id} className="border rounded-md px-2 py-1.5 text-sm">
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <div>{c.claim}</div>
                            <div className="text-xs text-muted-foreground">
                              {c.source ?? "no source"}
                              {c.confirmed_on && ` · confirmed ${c.confirmed_on.slice(0, 10)} by ${c.confirmed_by ?? "—"}`}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {claimStatuses
                              .filter((s) => s !== c.status)
                              .map((s) => (
                                <form key={s} action={setClaimStatusAction.bind(null, clientId, c.id, s)}>
                                  <Button type="submit" size="xs" variant={s === "confirmed" ? "default" : "outline"}>
                                    {s === "confirmed" ? "Confirm" : claimStatusLabels[s]}
                                  </Button>
                                </form>
                              ))}
                            <form action={deleteClaimAction.bind(null, clientId, c.id)}>
                              <Button type="submit" size="xs" variant="ghost">✕</Button>
                            </form>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            <form action={addClaimAction.bind(null, clientId)} className="grid grid-cols-3 gap-2 border-t pt-3">
              <Input name="claim" placeholder="Claim (e.g. Licensed and insured)" required className="col-span-3 h-8 text-xs" />
              <Input name="source" placeholder="Source" className="col-span-2 h-8 text-xs" />
              <select name="status" defaultValue="unverified" className={selectClass}>
                {claimStatuses.map((s) => (
                  <option key={s} value={s}>{claimStatusLabels[s]}</option>
                ))}
              </select>
              <Button type="submit" size="sm" variant="outline" className="col-span-3">
                Add claim
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* ── Money keywords ────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Money keywords
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                protected · alerts on Map Pack / organic drops
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(moneyKeywords ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">None nominated yet.</p>
            ) : (
              <ul className="space-y-1">
                {(moneyKeywords ?? []).map((m) => (
                  <li key={m.id} className="border rounded-md px-2 py-1.5 text-sm">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium flex-1 min-w-0 truncate">
                        {m.keywords?.keyword}
                        {m.keywords?.city && (
                          <span className="text-xs text-muted-foreground"> · {m.keywords.city}</span>
                        )}
                      </span>
                      {m.confirmed_on ? (
                        <Badge variant="outline" className="bg-green-100 text-green-800 border-green-200 text-xs">
                          confirmed {m.confirmed_on.slice(0, 10)}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-amber-100 text-amber-800 border-amber-200 text-xs">
                          pending confirmation
                        </Badge>
                      )}
                      {m.confirmed_on ? (
                        <form action={unconfirmMoneyKeywordAction.bind(null, clientId, m.id)}>
                          <Button type="submit" size="xs" variant="outline">Unconfirm</Button>
                        </form>
                      ) : (
                        <form action={confirmMoneyKeywordAction.bind(null, clientId, m.id)}>
                          <Button type="submit" size="xs">Confirm</Button>
                        </form>
                      )}
                      <form action={removeMoneyKeywordAction.bind(null, clientId, m.id)}>
                        <Button type="submit" size="xs" variant="ghost">✕</Button>
                      </form>
                    </div>
                    <form
                      action={updateMoneyThresholdsAction.bind(null, clientId, m.id)}
                      className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"
                    >
                      <span>alert below</span>
                      <span>map</span>
                      <Input name="alert_threshold_map" type="number" min={1} max={20} defaultValue={m.alert_threshold_map} className="h-6 w-14 text-xs" />
                      <span>organic</span>
                      <Input name="alert_threshold_organic" type="number" min={1} max={50} defaultValue={m.alert_threshold_organic} className="h-6 w-14 text-xs" />
                      {m.confirmed_by && <span>· by {m.confirmed_by}</span>}
                      <Button type="submit" size="xs" variant="ghost">Save</Button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            {candidates.length > 0 && (
              <form action={addMoneyKeywordAction.bind(null, clientId)} className="flex items-center gap-2 border-t pt-3">
                <select name="keyword_id" className={cn(selectClass, "flex-1 min-w-0")} required defaultValue="">
                  <option value="" disabled>Nominate a keyword…</option>
                  {candidates.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.keyword}
                      {k.volume != null ? ` (${k.volume}/mo)` : ""}
                    </option>
                  ))}
                </select>
                <Button type="submit" size="sm" variant="outline">Add</Button>
              </form>
            )}
          </CardContent>
        </Card>

        {/* ── Keyword map ───────────────────────────────────────────── */}
        <Card className="xl:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Keyword map
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {(keywords ?? []).length} keywords · {(keywords ?? []).filter((k) => k.is_tracked).length} tracked ·{" "}
                <Link href={`/clients/${clientId}/keywords`} className="text-primary hover:underline">
                  rankings on the Keywords tab
                </Link>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(keywords ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No keywords yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1 pr-2 font-medium">Keyword</th>
                      <th className="py-1 pr-2 font-medium">City</th>
                      <th className="py-1 pr-2 font-medium text-right">Vol/mo</th>
                      <th className="py-1 pr-2 font-medium text-right">CPC</th>
                      <th className="py-1 pr-2 font-medium text-right">Comp.</th>
                      <th className="py-1 pr-2 font-medium">Pri</th>
                      <th className="py-1 pr-2 font-medium">Flags</th>
                      <th className="py-1 pr-2 font-medium">Intent / notes</th>
                      <th className="py-1 pr-2 font-medium">Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(keywords ?? []).map((k) => (
                      <tr key={k.id} className={cn("border-t", !k.is_active && "opacity-50")}>
                        <td className="py-1 pr-2 font-medium whitespace-nowrap">{k.keyword}</td>
                        <td className="py-1 pr-2 whitespace-nowrap">{k.city ?? ""}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{k.volume ?? "—"}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{money(k.cpc)}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{k.competition ?? "—"}</td>
                        <td className="py-1 pr-2 uppercase">{k.priority}</td>
                        <td className="py-1 pr-2 whitespace-nowrap">
                          {k.is_money && (
                            <Badge variant="outline" className="bg-green-100 text-green-800 border-green-200 text-[10px] mr-1">money</Badge>
                          )}
                          {k.is_tracked && (
                            <Badge variant="outline" className="text-[10px]">tracked</Badge>
                          )}
                        </td>
                        <td className="py-1 pr-2 max-w-72 truncate text-muted-foreground" title={k.intent ?? undefined}>
                          {k.intent ?? ""}
                        </td>
                        <td className="py-1 pr-2 max-w-48 truncate text-muted-foreground">{k.target_url ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
