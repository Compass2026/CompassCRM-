import { createHash } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  deletePostAction,
  publishNowAction,
  reopenPostAction,
  revisePostAction,
  submitPostAction,
  unlinkAssetAction,
  unlinkClaimAction,
  unschedulePostAction,
  withdrawPostAction,
} from "@/app/social-post-actions";
import {
  LinkAssetForm,
  LinkClaimForm,
  MarkPublishedForm,
  PostDraftForm,
  PostStepButton,
  ReviewForms,
  ScheduleForm,
} from "@/components/post-forms";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { listTeamMembers } from "@/lib/team";
import { actorName, formatStamp, isUuid } from "@/lib/tasks";
import {
  availableActions,
  CRM_FACTS_HELP,
  describePostEvent,
  topicProblem,
  isPlatform,
  isPublishStatus,
  isReviewStatus,
  platformLabels,
  publishLabels,
  reviewLabels,
} from "@/lib/social-posts";
import { approvedChannelProblems, MAX_ATTEMPTS, modeLabels, outcomeLabels, parsePublisherSettings } from "@/lib/publisher";
import { drafterSummary } from "@/lib/drafter-run";
import { cn } from "@/lib/utils";

const claimStyles: Record<string, string> = {
  confirmed: "bg-green-100 text-green-800",
  sourced: "bg-blue-100 text-blue-800",
  unverified: "bg-red-100 text-red-800",
};

export default async function PostPage({ params }: { params: Promise<{ clientId: string; postId: string }> }) {
  const { clientId, postId } = await params;
  if (!isUuid(clientId) || !isUuid(postId)) notFound();
  const supabase = await createClient();

  const { data: post } = await supabase
    .from("social_posts")
    .select("*")
    .eq("id", postId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (!post || !isReviewStatus(post.review_status) || !isPublishStatus(post.publish_status)) notFound();

  const [members, { data: linked }, { data: claims }, { data: services }, { data: offers }, { data: keywords }, readiness, { data: events }, { data: task }, { data: assets }] =
    await Promise.all([
      listTeamMembers(supabase),
      supabase.from("post_claims").select("claim_id, claims(id, claim, status, source)").eq("post_id", postId),
      supabase.from("claims").select("id, claim, status, source").eq("client_id", clientId).order("created_at"),
      supabase.from("services").select("id, name, status").eq("client_id", clientId).order("sort_order"),
      supabase.from("offers").select("id, title, terms, status, starts_on, ends_on").eq("client_id", clientId).order("title"),
      supabase.from("keywords").select("id, keyword").eq("client_id", clientId).eq("is_tracked", true).order("keyword"),
      supabase.rpc("social_post_readiness", { p_post_id: postId }),
      supabase.from("post_events").select("id, kind, actor_kind, actor_id, from_value, to_value, detail, created_at").eq("post_id", postId).order("id"),
      post.review_task_id
        ? supabase.from("tasks").select("id, title, status").eq("id", post.review_task_id).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from("post_assets").select("brand_asset_id, sort_order, brand_assets(label, kind, storage_path, url)").eq("post_id", postId).order("sort_order"),
    ]);
  const isGbp = post.platform === "google_business";
  const [{ data: runs }, { data: publisherRow }] = isGbp || post.publish_status !== "not_scheduled"
    ? await Promise.all([
        supabase.from("publisher_runs").select("id, mode, outcome, transient, http_status, detail, task_id, created_at").eq("post_id", postId).order("id", { ascending: false }).limit(20),
        supabase.from("app_settings").select("value").eq("key", "publisher").maybeSingle(),
      ])
    : [{ data: null }, { data: null }];
  const publisher = parsePublisherSettings(publisherRow?.value);
  // An AI-drafted post (0047): its run, and what changed since the linter passed it.
  const { data: drafterRun } = post.drafter_run_id
    ? await supabase
        .from("drafter_runs")
        .select("id, created_at, runtime, attempt, status, requested_via, brief_version, brief_hash, copy_hash, claim_ids, lint, target")
        .eq("id", post.drafter_run_id)
        .maybeSingle()
    : { data: null };
  const drafter = drafterRun
    ? drafterSummary(drafterRun, {
        copy: post.copy,
        cta_url: post.cta_url,
        linkedClaimIds: (linked ?? []).map((l) => l.claim_id),
        copyHash: createHash("sha256").update(post.copy ?? "", "utf8").digest("hex"),
      })
    : null;
  const channel = isGbp && post.review_status === "approved" ? approvedChannelProblems(post.approved_snapshot) : [];
  const { data: brandAssets } = await supabase
    .from("brand_assets")
    .select("id, label, kind")
    .eq("client_id", clientId)
    .order("kind")
    .order("sort_order");

  const names = new Map(members.map((m) => [m.id, m.name]));
  const problems = readiness.data ?? [];
  const actions = availableActions(post);
  const topic = topicProblem(post);
  const linkedAssetIds = new Set((assets ?? []).map((a) => a.brand_asset_id));
  const linkedIds = new Set((linked ?? []).map((l) => l.claim_id));
  const usableToLink = (claims ?? []).filter(
    (c) => !linkedIds.has(c.id) && (c.status === "confirmed" || (c.status === "sourced" && (c.source ?? "").trim() !== ""))
  );
  const service = (services ?? []).find((s) => s.id === post.service_id);
  const offer = (offers ?? []).find((o) => o.id === post.offer_id);
  const keyword = (keywords ?? []).find((k) => k.id === post.keyword_id);
  const review = reviewLabels[post.review_status];
  const publish = publishLabels[post.publish_status];
  const platform = isPlatform(post.platform) ? platformLabels[post.platform].label : post.platform;
  const snapshot = (post.approved_snapshot ?? null) as { copy?: string } | null;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-1">
        <Link href={`/clients/${clientId}/social`} className="text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-primary">
          &larr; Posts
        </Link>
        <h2 className="text-lg font-semibold">
          {platform} post{post.post_type !== "standard" ? ` (${post.post_type})` : ""}
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline" className={cn("text-[10px]", review.className)}>{review.label}</Badge>
          <Badge variant="outline" className={cn("text-[10px]", publish.className)}>{publish.label}</Badge>
          <span>{post.search_intent}</span>
          <span>·</span>
          <span>
            {post.author_kind === "worker" ? "Drafted by the worker" : `Drafted by ${actorName(post.created_by, names)}`},{" "}
            {formatStamp(post.created_at)}
          </span>
        </div>
      </div>

      {drafter && (
        <section aria-label="AI Drafter" className="surface space-y-2 p-4 text-sm sm:p-5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge variant="outline" className="border-violet-200 bg-violet-100 text-[10px] text-violet-800">AI</Badge>
            <span className="font-semibold">AI Drafter</span>
            <span className="text-muted-foreground">· {drafter.runtime}</span>
            <Badge
              variant="outline"
              className={cn("text-[10px]", drafter.lintPassed ? "border-green-200 bg-green-100 text-green-800" : "border-red-200 bg-red-100 text-red-800")}
            >
              {drafter.lintPassed ? "lint passed" : "lint not passed"}
            </Badge>
            <span className="font-mono text-xs text-muted-foreground" title={drafter.briefHash}>
              brief {drafter.briefHashShort} · {drafter.briefVersion}
            </span>
            {drafter.editedAfterCheck.length > 0 && (
              <Badge variant="outline" className="border-amber-200 bg-amber-100 text-[10px] text-amber-900">
                edited after check: {drafter.editedAfterCheck.join(", ")}
              </Badge>
            )}
          </div>
          <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-xs">
            <dt className="text-muted-foreground">Target page</dt>
            <dd className="break-all">{drafter.targetPage ?? "—"}</dd>
            <dt className="text-muted-foreground">Linked claims</dt>
            <dd>{drafter.claimCount} chosen by the drafter (listed below)</dd>
          </dl>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Details</summary>
            <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-y-1">
              <dt className="text-muted-foreground">Brief hash</dt>
              <dd className="break-all font-mono">{drafter.briefHash}</dd>
              <dt className="text-muted-foreground">Attempt</dt>
              <dd>{drafter.attempt} of 3</dd>
              <dt className="text-muted-foreground">Requested by</dt>
              <dd>{drafter.requestedVia === "worker" ? "the worker" : "a team member"}</dd>
              <dt className="text-muted-foreground">Warnings</dt>
              <dd>
                {drafter.warnings.length === 0
                  ? "none"
                  : drafter.warnings.map((w) => (
                      <span key={`${w.code}:${w.message}`} className="block">{w.message}</span>
                    ))}
              </dd>
            </dl>
          </details>
        </section>
      )}

      {post.review_status === "rejected" && post.review_note && (
        <div role="note" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          Rejected by {actorName(post.reviewed_by, names)}: “{post.review_note}”
        </div>
      )}
      {post.review_status === "draft" && post.review_note && (
        <div role="note" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Last review note: “{post.review_note}”
        </div>
      )}

      {/* Content: editable only as a draft. */}
      <section className="surface space-y-3 p-4 sm:p-5">
        <h3 className="text-sm font-semibold">Content</h3>
        {actions.includes("edit") ? (
          <PostDraftForm
            clientId={clientId}
            postId={postId}
            post={post}
            services={(services ?? []).filter((s) => s.status === "approved" || s.id === post.service_id).map((s) => ({ id: s.id, label: s.name }))}
            offers={(offers ?? []).filter((o) => o.status !== "retired" || o.id === post.offer_id).map((o) => ({ id: o.id, label: `${o.title}${o.status === "confirmed" ? "" : ` (${o.status})`}` }))}
            keywords={(keywords ?? []).map((k) => ({ id: k.id, label: k.keyword }))}
          />
        ) : (
          <div className="space-y-2 text-sm">
            <p className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3">{post.copy}</p>
            <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-xs">
              {post.cta_type && (<><dt className="text-muted-foreground">Button</dt><dd>{post.cta_type.replace("_", " ").toLowerCase()} → {post.cta_url ?? "—"}</dd></>)}
              {service && (<><dt className="text-muted-foreground">Service</dt><dd>{service.name}{service.status !== "approved" && ` (${service.status})`}</dd></>)}
              {offer && (<><dt className="text-muted-foreground">Offer</dt><dd>{offer.title}: “{offer.terms}” ({offer.status}{offer.ends_on ? `, ends ${offer.ends_on}` : ", no end date"})</dd></>)}
              {keyword && (<><dt className="text-muted-foreground">Keyword</dt><dd>{keyword.keyword}</dd></>)}
              {post.crm_facts_only && (<><dt className="text-muted-foreground">CRM facts only</dt><dd>{CRM_FACTS_HELP}</dd></>)}
            </dl>
            <p className="text-xs text-muted-foreground">
              {post.review_status === "approved"
                ? "Approved content is frozen. Reopen it to change anything; that clears the approval."
                : "Submitted content is frozen. Withdraw it to edit."}
            </p>
          </div>
        )}
      </section>

      {/* What the post stands on. */}
      <section className="surface space-y-3 p-4 sm:p-5">
        <h3 className="text-sm font-semibold">Claims it stands on</h3>
        {(linked ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No claims linked.{" "}
            {post.search_intent === "navigational"
              ? "A navigational post may go without one only when it is marked “CRM facts only”."
              : "Informational, commercial and transactional posts need at least one confirmed or sourced claim."}
          </p>
        ) : (
          <ul className="space-y-2">
            {(linked ?? []).map((l) => {
              const c = l.claims;
              if (!c) return null;
              return (
                <li key={l.claim_id} className="flex flex-wrap items-start gap-2 text-sm">
                  <Badge variant="outline" className={cn("text-[10px]", claimStyles[c.status] ?? "")}>{c.status}</Badge>
                  <span className="min-w-0 flex-1">
                    {c.claim}
                    {c.source && <span className="block break-all text-xs text-muted-foreground">Source: {c.source}</span>}
                  </span>
                  {actions.includes("edit") && (
                    <form action={unlinkClaimAction.bind(null, clientId, postId, l.claim_id)}>
                      <Button type="submit" variant="ghost" size="sm">Unlink</Button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {actions.includes("edit") && <LinkClaimForm clientId={clientId} postId={postId} claims={usableToLink.map((c) => ({ id: c.id, label: `${c.claim} (${c.status})` }))} />}
        {topic && problems.length === 0 && <p className="text-sm text-amber-900">{topic}</p>}
        {post.review_status !== "approved" || post.publish_status !== "published" ? (
          problems.length > 0 ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-medium">Not ready for {post.review_status === "in_review" ? "approval" : "review"}:</p>
              <ul className="mt-1 list-disc pl-5">
                {problems.map((m) => (<li key={m}>{m}</li>))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-green-800">Grounding checks pass.</p>
          )
        ) : null}
      </section>

      {/* Media: brand assets, in order. */}
      <section className="surface space-y-3 p-4 sm:p-5">
        <h3 className="text-sm font-semibold">Media</h3>
        {(assets ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No brand assets on this post.</p>
        ) : (
          <ol className="space-y-1 text-sm">
            {(assets ?? []).map((a) => (
              <li key={a.brand_asset_id} className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground tabular-nums">{a.sort_order}.</span>
                <span className="min-w-0 flex-1">
                  {a.brand_assets?.label ?? a.brand_asset_id}
                  {a.brand_assets?.kind && <span className="text-xs text-muted-foreground"> · {a.brand_assets.kind}</span>}
                </span>
                {actions.includes("edit") && (
                  <form action={unlinkAssetAction.bind(null, clientId, postId, a.brand_asset_id)}>
                    <Button type="submit" variant="ghost" size="sm">Remove</Button>
                  </form>
                )}
              </li>
            ))}
          </ol>
        )}
        {actions.includes("edit") && (
          <LinkAssetForm
            clientId={clientId}
            postId={postId}
            assets={(brandAssets ?? []).filter((b) => !linkedAssetIds.has(b.id)).map((b) => ({ id: b.id, label: `${b.label} (${b.kind})` }))}
          />
        )}
      </section>

      {/* Review and scheduling. */}
      <section className="surface space-y-4 p-4 sm:p-5">
        <h3 className="text-sm font-semibold">Review and publishing</h3>
        {post.review_status === "approved" && (
          <p className="text-sm">
            Approved by <span className="font-medium">{actorName(post.reviewed_by, names)}</span>
            {post.reviewed_at && ` on ${formatStamp(post.reviewed_at)}`}
            {post.review_note ? `: “${post.review_note}” ` : ". "}
            <span className="font-mono text-xs text-muted-foreground" title="Fingerprint of the approved content">
              {post.approved_hash?.slice(0, 12)}
            </span>
          </p>
        )}
        {snapshot?.copy && snapshot.copy !== post.copy && (
          <p className="text-xs text-red-700">The live copy differs from what was approved; it cannot be published.</p>
        )}
        {task && (
          <p className="text-xs text-muted-foreground">
            Review task: <Link href={`/tasks/${task.id}`} className="underline">{task.title}</Link> ({task.status})
          </p>
        )}
        <div className="flex flex-wrap items-start gap-3">
          {actions.includes("submit") && (
            <PostStepButton action={submitPostAction.bind(null, clientId, postId)} label="Submit for review" />
          )}
          {actions.includes("withdraw") && (
            <PostStepButton action={withdrawPostAction.bind(null, clientId, postId)} label="Withdraw to edit" variant="outline" />
          )}
          {actions.includes("revise") && (
            <PostStepButton action={revisePostAction.bind(null, clientId, postId)} label="Revise" />
          )}
          {actions.includes("publish_now") && (
            <PostStepButton
              action={publishNowAction.bind(null, clientId, postId)}
              label="Publish now"
              confirm="Publish this approved post to the client's Business Profile now?"
            />
          )}
          {actions.includes("unschedule") && (
            <PostStepButton action={unschedulePostAction.bind(null, clientId, postId)} label="Unschedule" variant="outline" />
          )}
          {actions.includes("reopen") && (
            <PostStepButton
              action={reopenPostAction.bind(null, clientId, postId)}
              label="Reopen (clears approval)"
              variant="outline"
              confirm="Reopening clears the approval and unschedules the post. Continue?"
            />
          )}
        </div>
        {actions.includes("approve") && post.submitted_at && (
          <ReviewForms clientId={clientId} postId={postId} submittedAt={post.submitted_at} ready={problems.length === 0} />
        )}
        {actions.includes("schedule") && (
          <ScheduleForm clientId={clientId} postId={postId} fromPublish={post.publish_status} />
        )}
        {actions.includes("mark_published") && (
          <MarkPublishedForm clientId={clientId} postId={postId} fromPublish={post.publish_status} />
        )}
        {post.review_status === "approved" && isGbp && post.publish_status !== "published" && (
          <p className="text-xs text-muted-foreground">
            Business Profile posts are published by the publisher only, scheduled or with Publish now; they cannot be
            marked published by hand.{" "}
            {!publisher.enabled
              ? "The publisher is switched off (Settings → Publisher)."
              : !publisher.clients.includes(clientId)
                ? "This client is not on the publisher's pilot list (Settings → Publisher)."
                : null}
          </p>
        )}
        {channel.length > 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-medium">Google would refuse the approved content:</p>
            <ul className="mt-1 list-disc pl-5">
              {channel.map((m) => (<li key={m}>{m}</li>))}
            </ul>
            <p className="mt-1 text-xs">Reopen the post, fix it and approve it again.</p>
          </div>
        )}
        {isGbp && post.publish_attempts > 0 && post.publish_status !== "published" && (
          <p className="text-xs text-muted-foreground">
            Attempt {post.publish_attempts} of {MAX_ATTEMPTS}
            {post.last_attempt_at && `, last ${formatStamp(post.last_attempt_at)}`}. Only 429, 5xx and network errors are retried
            automatically.
          </p>
        )}
        {post.publish_status === "scheduled" && post.scheduled_at && (
          <p className="text-sm">Scheduled for {formatStamp(post.scheduled_at)} (Central).</p>
        )}
        {post.publish_status === "failed" && post.error && (
          <p className="text-sm text-red-700">Last attempt failed: {post.error}</p>
        )}
        {post.publish_status === "published" && (
          <p className="text-sm">
            Published {post.published_at && formatStamp(post.published_at)}
            {post.published_url && (<> · <a href={post.published_url} className="underline" target="_blank" rel="noreferrer">view</a></>)}
          </p>
        )}
        {actions.includes("delete") && (
          <form action={deletePostAction.bind(null, clientId, postId)} className="pt-2">
            <Button type="submit" variant="destructive" size="sm">Delete draft</Button>
          </form>
        )}
      </section>

      {(runs ?? []).length > 0 && (
        <section className="surface space-y-3 p-4 sm:p-5">
          <h3 className="text-sm font-semibold">Publisher</h3>
          <ol className="space-y-2 text-sm">
            {(runs ?? []).map((r) => {
              const o = outcomeLabels[r.outcome] ?? { label: r.outcome, className: "" };
              return (
                <li key={r.id} className="flex flex-wrap items-start gap-2">
                  <Badge variant="outline" className={cn("text-[10px]", o.className)}>{o.label}</Badge>
                  <span className="min-w-0 flex-1">
                    {r.detail}
                    {r.http_status ? <span className="text-xs text-muted-foreground"> (HTTP {r.http_status}{r.transient ? ", transient" : ""})</span> : null}
                    <span className="block text-xs text-muted-foreground">
                      {modeLabels[r.mode] ?? r.mode} · <time dateTime={r.created_at}>{formatStamp(r.created_at)}</time>
                      {r.task_id && (<> · <Link href={`/tasks/${r.task_id}`} className="underline">task</Link></>)}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <section className="surface space-y-3 p-4 sm:p-5">
        <h3 className="text-sm font-semibold">History</h3>
        <ol className="space-y-2 border-l pl-4">
          {(events ?? []).map((e) => (
            <li key={e.id} className="text-xs text-muted-foreground">
              <span>{describePostEvent(e, names)}</span> · <time dateTime={e.created_at}>{formatStamp(e.created_at)}</time>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
