import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PostDraftForm } from "@/components/post-forms";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { chip } from "@/lib/nav-styles";
import { formatStamp } from "@/lib/tasks";
import {
  displayState,
  isPlatform,
  isPublishStatus,
  isReviewStatus,
  platformLabels,
  reviewLabels,
  REVIEW_STATUSES,
} from "@/lib/social-posts";
import { cn } from "@/lib/utils";

// Posts and their review gate (0045). Every post is a draft until a person
// approves it. Business Profile posts publish only through post-publisher
// (0046); other platforms are posted by hand and marked published.
export default async function SocialPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ view?: string; month?: string; review?: string }>;
}) {
  const { clientId } = await params;
  const { view = "list", month, review } = await searchParams;
  const supabase = await createClient();

  const [{ data: posts }, { data: plan }, { data: services }, { data: offers }, { data: keywords }] = await Promise.all([
    supabase
      .from("social_posts")
      .select("id, platform, post_type, search_intent, copy, review_status, publish_status, scheduled_at, published_at, submitted_at, author_kind, created_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false }),
    supabase.from("plans").select("social_posts_per_month").eq("client_id", clientId).maybeSingle(),
    supabase.from("services").select("id, name").eq("client_id", clientId).eq("status", "approved").order("sort_order"),
    supabase.from("offers").select("id, title, status").eq("client_id", clientId).neq("status", "retired").order("title"),
    supabase.from("keywords").select("id, keyword").eq("client_id", clientId).eq("is_tracked", true).order("keyword"),
  ]);

  const all = (posts ?? []).filter((p) => isReviewStatus(p.review_status) && isPublishStatus(p.publish_status));
  const reviewFilter = isReviewStatus(review) ? review : null;
  const shown = reviewFilter ? all.filter((p) => p.review_status === reviewFilter) : all;
  const counts = new Map(REVIEW_STATUSES.map((s) => [s, all.filter((p) => p.review_status === s).length]));

  const now = new Date();
  const monthStr = month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [year, mon] = monthStr.split("-").map(Number);
  const publishedThisMonth = all.filter(
    (p) => p.publish_status === "published" && (p.published_at ?? "").startsWith(monthStr)
  ).length;

  // Calendar: approved posts by their scheduled (or published) day.
  const firstDay = new Date(Date.UTC(year, mon - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const cells: (number | null)[] = [
    ...Array<null>(firstDay.getUTCDay()).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  const byDay = new Map<number, typeof all>();
  for (const p of all) {
    const when = p.published_at ?? p.scheduled_at;
    if (when?.startsWith(monthStr)) {
      const day = Number(when.slice(8, 10));
      byDay.set(day, [...(byDay.get(day) ?? []), p]);
    }
  }
  const fmtMonth = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const prevMonth = fmtMonth(new Date(Date.UTC(year, mon - 2, 1)));
  const nextMonth = fmtMonth(new Date(Date.UTC(year, mon, 1)));
  const short = (p: string) => (isPlatform(p) ? platformLabels[p].short : p);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/clients/${clientId}/social?view=list`} className={chip(view === "list")}>
          Posts
        </Link>
        <Link href={`/clients/${clientId}/social?view=calendar&month=${monthStr}`} className={chip(view === "calendar")}>
          Calendar
        </Link>
        <Link href={`/clients/${clientId}/social?view=new`} className={chip(view === "new")}>
          New post
        </Link>
        <span className="ml-auto text-sm text-muted-foreground">
          Published in {monthStr}: <span className="font-medium text-foreground">{publishedThisMonth}</span>
          {plan?.social_posts_per_month != null && ` / ${plan.social_posts_per_month} planned`}
        </span>
      </div>

      {view === "new" ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">New post draft</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-xs text-muted-foreground">
              A draft stays a draft until it is submitted and a teammate approves it. Informational, commercial and
              transactional posts need a confirmed or sourced claim; link claims on the next page.
            </p>
            <PostDraftForm
              clientId={clientId}
              services={(services ?? []).map((s) => ({ id: s.id, label: s.name }))}
              offers={(offers ?? []).map((o) => ({ id: o.id, label: `${o.title}${o.status === "confirmed" ? "" : ` (${o.status})`}` }))}
              keywords={(keywords ?? []).map((k) => ({ id: k.id, label: k.keyword }))}
            />
          </CardContent>
        </Card>
      ) : view === "calendar" ? (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <Link href={`/clients/${clientId}/social?view=calendar&month=${prevMonth}`} className="text-sm text-muted-foreground hover:text-foreground">
                ← {prevMonth}
              </Link>
              <CardTitle className="text-base">{monthStr}</CardTitle>
              <Link href={`/clients/${clientId}/social?view=calendar&month=${nextMonth}`} className="text-sm text-muted-foreground hover:text-foreground">
                {nextMonth} →
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            <div className="mb-1 grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                <div key={d}>{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {cells.map((day, i) => (
                <div key={i} className={cn("min-h-20 rounded border p-1 text-xs", day == null && "border-transparent bg-muted/30")}>
                  {day != null && (
                    <>
                      <div className="text-muted-foreground">{day}</div>
                      {(byDay.get(day) ?? []).map((p) => (
                        <Link
                          key={p.id}
                          href={`/clients/${clientId}/social/${p.id}`}
                          className={cn("mt-0.5 block truncate rounded px-1 py-0.5", displayState(p).className)}
                          title={p.copy ?? ""}
                        >
                          {short(p.platform)} {p.copy?.slice(0, 20) ?? "(no copy)"}
                        </Link>
                      ))}
                    </>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Posts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2" aria-label="Filter by review status">
              <Link href={`/clients/${clientId}/social`} className={chip(!reviewFilter)}>
                All {all.length}
              </Link>
              {REVIEW_STATUSES.map((s) => (
                <Link key={s} href={`/clients/${clientId}/social?review=${s}`} className={chip(reviewFilter === s)}>
                  {reviewLabels[s].label} {counts.get(s)}
                </Link>
              ))}
            </div>
            {shown.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {all.length === 0 ? "No posts yet." : "No posts in this view."}
              </p>
            )}
            <ul className="divide-y rounded-md border">
              {shown.map((p) => {
                const state = displayState(p);
                return (
                  <li key={p.id}>
                    <Link href={`/clients/${clientId}/social/${p.id}`} className="flex flex-col gap-1 p-3 hover:bg-muted/50 sm:flex-row sm:items-center sm:gap-3">
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant="secondary">{short(p.platform)}</Badge>
                        <Badge variant="outline" className={cn("text-[10px]", state.className)}>
                          {state.label}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{p.search_intent}</span>
                      </div>
                      <span className="min-w-0 flex-1 truncate text-sm">{p.copy ?? "(no copy)"}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {p.published_at
                          ? `Published ${formatStamp(p.published_at)}`
                          : p.scheduled_at && p.publish_status === "scheduled"
                            ? `For ${formatStamp(p.scheduled_at)}`
                            : `${p.author_kind === "worker" ? "Worker" : "Team"} draft · ${formatStamp(p.created_at)}`}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
