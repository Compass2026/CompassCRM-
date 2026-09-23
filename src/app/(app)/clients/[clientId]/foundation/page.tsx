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
import { ProvisionButton } from "@/components/provision-button";
import { RedeployButton } from "@/components/redeploy-button";
import { BuildBriefButton } from "@/components/build-brief-button";
import { WorkModeSelect } from "@/components/work-mode-select";
import type { BuildBrief } from "@/lib/build-brief";
import { RevertButton } from "@/components/revert-button";
import { parseAudit, parseQuality, scoreTone, shortDate } from "@/lib/site-status";

const selectClass =
  "field-sm";

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
    { data: site },
    { data: workerPipelines },
    { data: brandAssets },
    { data: siteChanges },
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
    supabase
      .from("sites")
      .select(
        "id, url, stack, controlled_by_compass, repo_url, branch, preview_branch, vercel_project, staging_url, last_pushed_at, last_commit_url, quality, quality_checked_at, audit, audit_checked_at, content_paths, work_mode, content_adapter, foundation_version, foundation_sha, build_brief, build_brief_at"
      )
      .eq("client_id", clientId)
      .order("created_at")
      .limit(1)
      .maybeSingle(),
    supabase
      .from("client_pipelines")
      .select(
        `status, pipelines!inner(key),
         client_stages(id, status, evidence, next_action, stages(name))`
      )
      .eq("client_id", clientId)
      .in("pipelines.key", ["website", "seo"]),
    supabase
      .from("brand_assets")
      .select("id, kind, label, storage_path, url, mime_type, width, height, is_primary, sort_order")
      .eq("client_id", clientId)
      .in("kind", ["logo_primary", "logo_alt", "wordmark", "photo"])
      .order("is_primary", { ascending: false })
      .order("sort_order")
      .order("created_at"),
    supabase
      .from("change_log")
      .select("id, change_type, after, reasoning, created_at")
      .eq("client_id", clientId)
      .eq("object_type", "site")
      .in("change_type", ["page_added", "page_rewrite", "faq_added", "blog_post", "revert", "pull_request"])
      .order("created_at", { ascending: false })
      .limit(12),
  ]);
  const changeLabel: Record<string, string> = {
    page_added: "New page",
    page_rewrite: "Rewrite",
    faq_added: "FAQ",
    blog_post: "Blog post",
    revert: "Put back",
    pull_request: "Pull request",
  };
  const changeAfter = (a: unknown) => (a && typeof a === "object" ? (a as Record<string, unknown>) : {});
  const lastChange = siteChanges?.[0];

  // Logo + photo strip: sign the private bucket paths once for the page.
  const assetPaths = (brandAssets ?? []).map((a) => a.storage_path).filter((p): p is string => !!p);
  const signedAssets = new Map<string, string>();
  if (assetPaths.length) {
    const { data: signed } = await supabase.storage.from("brand-assets").createSignedUrls(assetPaths, 60 * 60);
    for (const row of signed ?? []) if (row.path && row.signedUrl) signedAssets.set(row.path, row.signedUrl);
  }
  const assetSrc = (a: { storage_path: string | null; url: string | null }) =>
    a.storage_path ? (signedAssets.get(a.storage_path) ?? null) : a.url;
  const logo = (brandAssets ?? []).find((a) => a.kind === "logo_primary") ?? (brandAssets ?? []).find((a) => a.kind === "wordmark" || a.kind === "logo_alt") ?? null;
  const photos = (brandAssets ?? []).filter((a) => a.kind === "photo").slice(0, 8);

  const workerStage = (pipeline: "website" | "seo", stageName: string) => {
    const cp = (workerPipelines ?? []).find((p) => p.pipelines?.key === pipeline);
    const cs = cp?.client_stages.find((c) => c.stages?.name === stageName);
    return cp && cs ? { enrollment: cp.status, ...cs } : null;
  };
  const buildStage = workerStage("website", "Build to 70%");
  const auditStage = workerStage("seo", "Audit & Adjust");
  const quality = parseQuality(site?.quality);
  const audit = parseAudit(site?.audit);
  const siteHost = (u: string | null | undefined) => {
    if (!u) return null;
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };

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

      {/* ── Provisioning: Drive folders + site repo ───────────────────── */}
      {folders.length < 6 && (
        <div className="border rounded-md bg-card px-3 py-2 space-y-1">
          <ProvisionButton clientId={clientId} />
          <p className="text-xs text-muted-foreground">
            Creates Compass Clients / {client?.name ?? "this client"} with its
            01–05 + Media subfolders and the site repo, then closes those two
            checklist items. Runs by itself when a client is created; this is
            the retry.
          </p>
        </div>
      )}

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

      {/* ── Site: build, deploy, audit ─────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-base">
              Site
              {site && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {site.stack} · {site.controlled_by_compass ? "Compass-controlled" : "client-controlled"}
                </span>
              )}
            </CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              {site?.repo_url && site.content_paths && (
                <RevertButton
                  clientId={clientId}
                  lastChange={lastChange ? `${changeLabel[lastChange.change_type] ?? lastChange.change_type} · ${String(changeAfter(lastChange.after).title ?? changeAfter(lastChange.after).url ?? "")}` : null}
                />
              )}
              {site?.repo_url && <RedeployButton clientId={clientId} />}
              {site && <BuildBriefButton clientId={clientId} hasBrief={!!site.build_brief} />}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!site ? (
            <p className="text-xs text-muted-foreground">
              No site row yet. The worker records one at Website › Discovery; provisioning adds the repo.
            </p>
          ) : (
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
              <span className="inline-flex items-center gap-1">
                <span className="text-muted-foreground">Work mode: </span>
                <WorkModeSelect clientId={clientId} value={site.work_mode} />
              </span>
              <span>
                <span className="text-muted-foreground">Updates: </span>
                {site.content_paths ? (
                  <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200 text-[10px]">on the contract · pages + weekly post publish here</Badge>
                ) : site.controlled_by_compass ? (
                  <Badge variant="outline" className="bg-amber-50 text-amber-800 border-amber-200 text-[10px]">not on the contract yet · Docs only</Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px]">client-run · Docs in 04 Website</Badge>
                )}
              </span>
              <span>
                <span className="text-muted-foreground">Live: </span>
                {site.url ? (
                  <a href={site.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    {siteHost(site.url)}
                  </a>
                ) : (
                  "none"
                )}
              </span>
              <span>
                <span className="text-muted-foreground">Repo: </span>
                {site.repo_url ? (
                  <a href={site.repo_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    {site.repo_url.replace(/^https?:\/\/github\.com\//, "")}
                  </a>
                ) : (
                  "not created"
                )}
                {site.branch && (
                  <Badge
                    variant="outline"
                    className={cn(
                      "ml-1 text-[10px]",
                      site.branch !== "main" && "bg-amber-100 text-amber-800 border-amber-200"
                    )}
                    title={
                      site.branch === "main"
                        ? undefined
                        : "main already carries a site that is not ours; the build sits on this side branch to blend"
                    }
                  >
                    {site.branch}
                  </Badge>
                )}
                {site.preview_branch && (
                  <Badge variant="outline" className="ml-1 text-[10px]" title="latest preview branch; its pull request targets the branch of record">
                    preview: {site.preview_branch}
                  </Badge>
                )}
              </span>
              <span>
                <span className="text-muted-foreground">Adapter: </span>
                {site.content_adapter ?? "not detected"}
                {site.foundation_version && (
                  <span className="text-muted-foreground"> · Foundation {site.foundation_version}{site.foundation_sha ? ` @ ${site.foundation_sha.slice(0, 7)}` : ""}</span>
                )}
              </span>
              <span>
                <span className="text-muted-foreground">Staging: </span>
                {site.staging_url ? (
                  <a href={site.staging_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    {siteHost(site.staging_url)}
                  </a>
                ) : site.vercel_project ? (
                  site.vercel_project
                ) : (
                  "not deployed"
                )}
              </span>
              <span>
                <span className="text-muted-foreground">Last push: </span>
                {site.last_pushed_at ? (
                  site.last_commit_url ? (
                    <a href={site.last_commit_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                      {shortDate(site.last_pushed_at)}
                    </a>
                  ) : (
                    shortDate(site.last_pushed_at)
                  )
                ) : (
                  "never"
                )}
              </span>
            </div>
          )}
          {site?.build_brief && (() => {
            const b = site.build_brief as unknown as BuildBrief;
            const counts = b.page_plan.reduce<Record<string, number>>((acc, p) => ((acc[p.status] = (acc[p.status] ?? 0) + 1), acc), {});
            return (
              <div className="rounded-md border p-3 text-xs space-y-1">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-medium">
                    Build brief · {b.work_mode} · {b.standard.version} @ {b.standard.source_sha.slice(0, 7)} ({b.standard.applies_as})
                  </span>
                  <span className="text-muted-foreground">{site.build_brief_at ? shortDate(site.build_brief_at) : ""} · {b.generated_by}</span>
                </div>
                <div className="text-muted-foreground">
                  Production branch <code>{b.repository.production_branch}</code>
                  {b.repository.preview_branch && <> · preview <code>{b.repository.preview_branch}</code> · PR base <code>{b.repository.pr_base}</code></>}
                  {" · "}adapter {b.content_adapter.key}
                  {" · "}page plan {Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "empty"}
                </div>
                {b.missing_inputs.length > 0 && (
                  <details>
                    <summary className="cursor-pointer">{b.missing_inputs.length} missing input{b.missing_inputs.length === 1 ? "" : "s"}</summary>
                    <ul className="list-disc pl-4 mt-1 space-y-0.5">
                      {b.missing_inputs.map((m, i) => (
                        <li key={i}>{m}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {(b.preview.pull_request_url || b.preview.url) && (
                  <div>
                    {b.preview.url && (
                      <a href={b.preview.url} target="_blank" rel="noreferrer" className="text-primary hover:underline mr-3">
                        preview
                      </a>
                    )}
                    {b.preview.pull_request_url && (
                      <a href={b.preview.pull_request_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        pull request
                      </a>
                    )}
                  </div>
                )}
                {(b.evidence.builder_checks.length > 0 || b.evidence.deferred.length > 0) && (
                  <div className="text-muted-foreground">
                    Builder checks: {b.evidence.builder_checks.join("; ") || "none"}
                    {b.evidence.deferred.length > 0 && <> · deferred: {b.evidence.deferred.join("; ")}</>}
                    {" · "}independent review: {b.evidence.independent_review.join("; ") || "pending"}
                  </div>
                )}
              </div>
            );
          })()}
          {site && (siteChanges?.length ?? 0) > 0 && (
            <div>
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Recent changes</h3>
              <ul className="text-xs space-y-0.5">
                {siteChanges!.map((ch) => {
                  const a = changeAfter(ch.after);
                  const url = typeof a.url === "string" ? a.url : null;
                  const commit = typeof a.commit === "string" ? a.commit : null;
                  const title = typeof a.title === "string" ? a.title : url ?? "";
                  return (
                    <li key={ch.id} className="flex gap-2 items-baseline">
                      <span className="text-muted-foreground shrink-0 tabular-nums">{shortDate(ch.created_at)}</span>
                      <Badge variant="outline" className="text-[10px] shrink-0">{changeLabel[ch.change_type] ?? ch.change_type}</Badge>
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer" className="text-primary hover:underline truncate">{title}</a>
                      ) : (
                        <span className="truncate">{title}</span>
                      )}
                      {commit && (
                        <a href={commit} target="_blank" rel="noreferrer" className="text-muted-foreground hover:underline shrink-0">commit</a>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="grid gap-3 lg:grid-cols-2">
            {/* Build to 70% */}
            <div className="border rounded-md p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">Website › Build to 70% <span className="font-normal text-muted-foreground">PB4b</span></span>
                {buildStage ? (
                  <Badge variant="outline" className={cn("text-xs", stageStatusStyles[buildStage.status])}>
                    {buildStage.enrollment === "pending" ? "Waiting for Foundation" : stageStatusLabels[buildStage.status]}
                  </Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">not enrolled</span>
                )}
              </div>
              {quality?.score ? (
                <div className="flex items-center gap-1.5 flex-wrap text-xs">
                  {(["seo", "aeo", "geo"] as const).map((k) => (
                    <Badge key={k} variant="outline" className={cn("tabular-nums", scoreTone(quality.score![k]))}>
                      {k.toUpperCase()} {quality.score![k]}
                    </Badge>
                  ))}
                  <Badge
                    variant="outline"
                    className={quality.pass ? "bg-green-100 text-green-800 border-green-200" : "bg-red-100 text-red-800 border-red-200"}
                  >
                    {quality.pass ? "gate PASS" : `gate FAIL · ${quality.failures}`}
                  </Badge>
                  <span className="text-muted-foreground">
                    {quality.pages != null && `${quality.pages} pages · `}
                    {quality.placeholders != null && `${quality.placeholders} placeholders · `}
                    {quality.warnings} warnings
                    {quality.checkedAt && ` · ${shortDate(quality.checkedAt)}`}
                  </span>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No quality gate report yet.</p>
              )}
              {buildStage?.next_action && (
                <p className="text-xs"><span className="text-muted-foreground">Next: </span>{buildStage.next_action}</p>
              )}
              {buildStage?.evidence && (
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Evidence</summary>
                  <p className="mt-1 text-xs whitespace-pre-wrap">{buildStage.evidence}</p>
                </details>
              )}
            </div>

            {/* Audit & Adjust */}
            <div className="border rounded-md p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">SEO › Audit & Adjust <span className="font-normal text-muted-foreground">PB4a</span></span>
                {auditStage ? (
                  <Badge variant="outline" className={cn("text-xs", stageStatusStyles[auditStage.status])}>
                    {auditStage.enrollment === "pending" ? "Waiting for Foundation" : stageStatusLabels[auditStage.status]}
                  </Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">not enrolled</span>
                )}
              </div>
              {audit ? (
                <div className="space-y-1 text-xs">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {audit.gate &&
                      (["seo", "aeo", "geo"] as const).map((k) => (
                        <Badge key={k} variant="outline" className={cn("tabular-nums", scoreTone(audit.gate![k]))}>
                          {k.toUpperCase()} {audit.gate![k]}
                        </Badge>
                      ))}
                    {audit.findings && (
                      <span className="text-muted-foreground">
                        findings: <span className="text-red-700">{audit.findings.high} high</span> ·{" "}
                        <span className="text-amber-700">{audit.findings.medium} medium</span> · {audit.findings.low} low
                      </span>
                    )}
                  </div>
                  <p className="text-muted-foreground">
                    {audit.target && <>on {siteHost(audit.target)} · </>}
                    {audit.pages != null && `${audit.pages} pages · `}
                    {audit.pageGroups && `${audit.pageGroups.served}/${audit.pageGroups.total} page groups served`}
                    {audit.pageGroups && audit.pageGroups.missing > 0 && ` (${audit.pageGroups.missing} missing)`}
                    {audit.backlinks?.referringDomains != null && ` · ${audit.backlinks.referringDomains} referring domains`}
                    {audit.gbp && (audit.gbp.found ? ` · GBP ${audit.gbp.claimed ? "claimed" : "unclaimed"}${audit.gbp.rating != null ? ` ${audit.gbp.rating}★` : ""}${audit.gbp.reviews != null ? ` (${audit.gbp.reviews})` : ""}${audit.gbp.napMismatches ? ` · ${audit.gbp.napMismatches} NAP mismatches` : ""}` : " · no GBP found")}
                    {site?.audit_checked_at && ` · ${shortDate(site.audit_checked_at)}`}
                  </p>
                  {audit.reportUrl && (
                    <a href={audit.reportUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                      Audit report (Drive)
                    </a>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No audit yet.</p>
              )}
              {auditStage?.next_action && (
                <p className="text-xs"><span className="text-muted-foreground">Next: </span>{auditStage.next_action}</p>
              )}
              {auditStage?.evidence && (
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Evidence</summary>
                  <p className="mt-1 text-xs whitespace-pre-wrap">{auditStage.evidence}</p>
                </details>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

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
              {/* Logo + photos — what the scan and the worker actually pulled. */}
              <div className="lg:col-span-2 flex gap-3 items-stretch overflow-x-auto pb-1">
                <div className="shrink-0 w-40 h-28 rounded-lg border bg-white flex items-center justify-center p-3">
                  {logo && assetSrc(logo) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={assetSrc(logo)!} alt={logo.label} className="max-h-full max-w-full object-contain" />
                  ) : (
                    <span className="text-[11px] text-muted-foreground text-center">No logo yet</span>
                  )}
                </div>
                {photos.map((p) => {
                  const src = assetSrc(p);
                  return src ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={p.id} src={src} alt={p.label} title={p.label} className="shrink-0 h-28 w-40 rounded-lg border object-cover" />
                  ) : null;
                })}
                {photos.length === 0 && (
                  <div className="shrink-0 h-28 px-4 rounded-lg border border-dashed flex items-center text-xs text-muted-foreground">
                    No photos pulled yet — Brand Build files 6–12 from the site or the client&apos;s listings.
                  </div>
                )}
                <Link
                  href={`/clients/${clientId}/brand`}
                  className="shrink-0 h-28 px-3 rounded-lg border flex items-center text-xs text-primary hover:underline"
                >
                  All assets →
                </Link>
              </div>
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
