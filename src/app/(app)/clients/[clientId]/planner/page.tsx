import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/tasks";
import { platformLabels, isPlatform } from "@/lib/social-posts";
import {
  DELIVERABLES,
  deliverableLabels,
  isPurpose,
  OPPORTUNITY_DELIVERABLE,
  parseWeek,
  purposeLabels,
  summarize,
  type Deliverable,
} from "@/lib/content-planner";
import { PlanStatusBadge, SlotStrip, WeekNav } from "@/components/planner/planner-bits";
import {
  AddPlanItemForm,
  DeletePlanItemButton,
  EditPlanItemForm,
  HoldForm,
  LinkOutputForm,
  PlanFromAuthorityForm,
  UnlinkOutputButton,
} from "@/components/planner/plan-forms";
import { GenerateDraftForm, GeneratePageDraftForm } from "@/components/drafts/draft-forms";
import { draftStatusLabels, isDraftStatus } from "@/lib/content-drafts";

export const dynamic = "force-dynamic";

// The client's week of content (0065): what is planned per slot, why, and
// where each piece stands. Every read is the teammate's own (is_team()).
export default async function PlannerPage({ params, searchParams }: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const { clientId } = await params;
  if (!isUuid(clientId)) notFound();
  const week = parseWeek((await searchParams).week);
  const supabase = await createClient();

  const [clientQ, boardQ, linkedQ, servicesQ, keywordsQ, postsQ, blogsQ, oppsQ] = await Promise.all([
    supabase.from("clients").select("id, name, status").eq("id", clientId).maybeSingle(),
    supabase.from("content_plan_board").select("*").eq("client_id", clientId).eq("week_start", week)
      .order("planned_date", { ascending: true, nullsFirst: false }).order("created_at"),
    supabase.from("content_plan_items").select("social_post_id, content_post_id, authority_opportunity_id, week_start").eq("client_id", clientId),
    supabase.from("services").select("id, name").eq("client_id", clientId).eq("status", "approved").order("sort_order"),
    supabase.from("keywords").select("id, keyword").eq("client_id", clientId).eq("is_tracked", true).order("keyword"),
    supabase.from("social_posts").select("id, platform, review_status, copy, created_at").eq("client_id", clientId)
      .order("created_at", { ascending: false }).limit(60),
    supabase.from("content_posts").select("id, title, status").eq("client_id", clientId).eq("origin", "compass").order("title"),
    supabase.from("authority_opportunity_state")
      .select("id, content_type, topic, intent, section, action, effective_status, target_path")
      .eq("client_id", clientId).eq("present", true).in("effective_status", ["open", "in_progress"])
      .in("content_type", Object.keys(OPPORTUNITY_DELIVERABLE)).in("section", ["fix_now", "ready"]),
  ]);
  const client = clientQ.data;
  if (!client) notFound();
  const failure = boardQ.error ?? linkedQ.error;
  if (failure) {
    return <p className="surface p-4 text-sm text-red-700">The planner could not be read: {failure.message}</p>;
  }

  // View rows are typed nullable; the columns below are not null in the table.
  const items = (boardQ.data ?? []).flatMap((r) =>
    r.id && r.deliverable && r.topic && r.purpose ? [{ ...r, id: r.id, deliverable: r.deliverable, topic: r.topic, purpose: r.purpose }] : []);
  const summaries = summarize(items);
  const linkedPosts = new Set((linkedQ.data ?? []).flatMap((r) => (r.social_post_id ? [r.social_post_id] : [])));
  const linkedBlogs = new Set((linkedQ.data ?? []).flatMap((r) => (r.content_post_id ? [r.content_post_id] : [])));
  const plannedOpps = new Set((linkedQ.data ?? []).flatMap((r) => (r.authority_opportunity_id && r.week_start === week ? [r.authority_opportunity_id] : [])));
  const services = (servicesQ.data ?? []).map((s) => ({ id: s.id, label: s.name }));
  const keywords = (keywordsQ.data ?? []).map((k) => ({ id: k.id, label: k.keyword }));
  const serviceName = new Map((servicesQ.data ?? []).map((s) => [s.id, s.name]));
  const keywordName = new Map((keywordsQ.data ?? []).map((k) => [k.id, k.keyword]));
  const posts = postsQ.data ?? [];
  const postById = new Map(posts.map((p) => [p.id, p]));
  const blogById = new Map((blogsQ.data ?? []).map((b) => [b.id, b]));
  const opportunities = (oppsQ.data ?? [])
    .flatMap((o) => (o.id && o.topic && o.content_type && !plannedOpps.has(o.id) ? [{ ...o, id: o.id, topic: o.topic, content_type: o.content_type }] : []))
    .sort((a, b) => (a.section === b.section ? a.topic.localeCompare(b.topic) : a.section === "fix_now" ? -1 : 1));
  const base = `/clients/${clientId}`;
  const excerpt = (s: string | null) => ((s ?? "").length > 60 ? `${(s ?? "").slice(0, 60)}…` : s ?? "");

  return (
    <div className="space-y-6" data-planner>
      <div className="surface space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-base font-semibold">Content plan</h1>
          <Link href={`/production?week=${week}`} className="text-xs underline underline-offset-2">All clients this week</Link>
        </div>
        <WeekNav basePath={`${base}/planner`} week={week} />
        <p className="text-xs text-muted-foreground">
          The weekly target is 2 Social, 2 Business Profile, 2 Blogs and 1 Web page. It is a cadence, not a quota: leave a
          slot empty rather than fill it with weak work. Counts show approved or delivered pieces against the target.
        </p>
      </div>

      <SlotStrip summaries={summaries} />

      {DELIVERABLES.map((d: Deliverable) => {
        const mine = items.filter((i) => i.deliverable === d);
        return (
          <section key={d} className="surface space-y-3 p-4" data-planner-section={d}>
            <h2 className="text-sm font-semibold">
              {deliverableLabels[d].label}{" "}
              <span className="font-normal text-muted-foreground">· {summaries[d].done}/{summaries[d].target} ready</span>
            </h2>
            {mine.length === 0 && <p className="text-sm text-muted-foreground">Nothing planned yet.</p>}
            <ul className="space-y-3">
              {mine.map((i) => {
                const post = i.social_post_id ? postById.get(i.social_post_id) : null;
                const blog = i.content_post_id ? blogById.get(i.content_post_id) : null;
                const outputs = i.social_post_id || i.content_post_id ? [] : d === "blog"
                  ? (blogsQ.data ?? []).filter((b) => !linkedBlogs.has(b.id)).map((b) => ({ id: `blog:${b.id}`, label: `${b.title} (${b.status})` }))
                  : d === "social" || d === "gbp"
                    ? posts.filter((p) => p.platform === i.channel && !linkedPosts.has(p.id))
                        .map((p) => ({ id: `post:${p.id}`, label: `${p.review_status}: ${excerpt(p.copy)}` }))
                    : [];
                return (
                  <li key={i.id} className="space-y-2 rounded-md border p-3" data-plan-item={i.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <PlanStatusBadge status={i.status} />
                      <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{i.topic}</span>
                      <span className="text-xs text-muted-foreground">
                        {isPurpose(i.purpose) ? purposeLabels[i.purpose] : i.purpose}
                        {i.channel && i.deliverable === "social" && isPlatform(i.channel) ? ` · ${platformLabels[i.channel].label}` : ""}
                        {i.planned_date ? ` · ${i.planned_date}` : ""}
                      </span>
                    </div>
                    <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-y-0.5 text-xs [&>dd]:[overflow-wrap:anywhere]">
                      {i.search_intent && (<><dt className="text-muted-foreground">Intent</dt><dd>{i.search_intent}</dd></>)}
                      {i.service_id && (<><dt className="text-muted-foreground">Service</dt><dd>{serviceName.get(i.service_id) ?? "—"}</dd></>)}
                      {i.keyword_id && (<><dt className="text-muted-foreground">Keyword</dt><dd>{keywordName.get(i.keyword_id) ?? "—"}</dd></>)}
                      {i.target_url && (<><dt className="text-muted-foreground">Destination</dt><dd>{i.target_url}</dd></>)}
                      {i.authority_opportunity_id && (<><dt className="text-muted-foreground">Authority</dt><dd><Link href={`${base}/authority`} className="underline">opportunity</Link></dd></>)}
                      {post && (<><dt className="text-muted-foreground">Draft</dt><dd><Link href={`${base}/social/${post.id}`} className="underline">{excerpt(post.copy)}</Link> ({post.review_status})</dd></>)}
                      {blog && (<><dt className="text-muted-foreground">Blog</dt><dd><Link href={`${base}/content`} className="underline">{blog.title}</Link> ({blog.status})</dd></>)}
                      {i.output_url && (<><dt className="text-muted-foreground">Delivered at</dt><dd><a href={i.output_url} className="underline" target="_blank" rel="noreferrer">{i.output_url}</a></dd></>)}
                      {i.hold_reason && (<><dt className="text-muted-foreground">{i.hold === "blocked" ? "Waiting on" : "Note"}</dt><dd>{i.hold_reason}</dd></>)}
                      {i.notes && (<><dt className="text-muted-foreground">Notes</dt><dd>{i.notes}</dd></>)}
                    </dl>
                    {(d === "blog" || d === "web_page") && i.draft_id && (
                      <p className="text-sm" data-plan-draft>
                        <Link href={`${base}/drafts/${i.draft_id}`} className="font-medium underline">Open the draft</Link>
                        <span className="text-xs text-muted-foreground">
                          {" "}({isDraftStatus(i.draft_status) ? draftStatusLabels[i.draft_status].label.toLowerCase() : i.draft_status})
                        </span>
                      </p>
                    )}
                    {d === "blog" && !i.draft_id && !blog && i.status === "ready_to_generate" && (
                      <GenerateDraftForm clientId={clientId} planItemId={i.id} />
                    )}
                    {d === "web_page" && !i.draft_id && i.search_intent && i.hold !== "delivered" && (
                      <GeneratePageDraftForm clientId={clientId} planItemId={i.id} hasTarget={!!i.target_url} />
                    )}
                    {i.status === "ready_to_generate" && !post && !blog && d !== "blog" && d !== "web_page" && (
                      <p className="text-xs text-muted-foreground" data-next-step>
                        {d === "gbp" && i.authority_opportunity_id
                          ? <>Next: <Link href={`${base}/authority`} className="underline">Draft with AI</Link> on the Authority tab, then link the draft here.</>
                          : d === "social" || d === "gbp"
                            ? <>Next: <Link href={`${base}/social?view=new`} className="underline">write the post</Link>, then link it here.</>
                            : null}
                      </p>
                    )}
                    <div className="flex flex-wrap items-start gap-2">
                      <LinkOutputForm clientId={clientId} itemId={i.id} outputs={outputs} />
                      {(i.social_post_id || i.content_post_id) && <UnlinkOutputButton clientId={clientId} itemId={i.id} />}
                      {!i.social_post_id && !i.content_post_id && <DeletePlanItemButton clientId={clientId} itemId={i.id} />}
                    </div>
                    <HoldForm clientId={clientId} itemId={i.id} hold={i.hold} />
                    <EditPlanItemForm clientId={clientId} week={week} services={services} keywords={keywords}
                      item={{ id: i.id, deliverable: i.deliverable, purpose: i.purpose, topic: i.topic, search_intent: i.search_intent,
                              service_id: i.service_id, keyword_id: i.keyword_id, target_url: i.target_url, planned_date: i.planned_date, notes: i.notes }} />
                  </li>
                );
              })}
            </ul>
            <AddPlanItemForm clientId={clientId} week={week} deliverable={d} services={services} keywords={keywords} remaining={summaries[d].unplanned} />
          </section>
        );
      })}

      <section className="surface space-y-3 p-4" data-planner-authority>
        <h2 className="text-sm font-semibold">From Authority</h2>
        <p className="text-xs text-muted-foreground">
          Ready opportunities that fit a weekly slot (Business Profile posts, blogs and pages). Planning one keeps its
          opportunity, topic, intent, service and target page.
        </p>
        {opportunities.length === 0 ? (
          <p className="text-sm text-muted-foreground">No ready Authority opportunity is waiting to be planned this week.</p>
        ) : (
          <ul className="space-y-2">
            {opportunities.slice(0, 15).map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2 text-sm" data-opportunity={o.id}>
                <span className="rounded bg-muted px-1.5 text-[10px] uppercase tracking-wide">{deliverableLabels[OPPORTUNITY_DELIVERABLE[o.content_type]].short}</span>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  {o.topic}
                  <span className="text-xs text-muted-foreground"> · {o.content_type.replace(/_/g, " ")}{o.intent ? ` · ${o.intent}` : ""}{o.section === "fix_now" ? " · fix now" : ""}</span>
                </span>
                <PlanFromAuthorityForm clientId={clientId} week={week} opportunityId={o.id} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
