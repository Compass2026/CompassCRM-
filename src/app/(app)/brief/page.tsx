import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ownerLabels, stageStatusLabels, stageStatusStyles } from "@/lib/labels";
import { latestPerPost, needsAttention, outcomeLabels, parsePublisherSettings, STUCK_AFTER_MINUTES } from "@/lib/publisher";
import { cn } from "@/lib/utils";

// The brief (reconciliation build-order step 9): the one page Tom reads in
// the morning and again at the end of the day. Four questions, in order —
// what needs a decision from me, what is mine to do, what did Claude do
// that I might want to look at, and what happened at all. Everything here
// is read from rows the worker already writes; nothing is computed elsewhere.

const DAY = 24 * 60 * 60 * 1000;

function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60 * 60 * 1000) return `${Math.max(1, Math.round(ms / 60000))} min ago`;
  if (ms < DAY) return `${Math.round(ms / (60 * 60 * 1000))} h ago`;
  return `${Math.round(ms / DAY)} d ago`;
}

// Computed outside the component body so the purity lint is satisfied: a
// server component renders once per request, so "now" is fine to read.
function windows() {
  const now = Date.now();
  return {
    since24h: new Date(now - DAY).toISOString(),
    since7d: new Date(now - 7 * DAY).toISOString(),
    since14d: new Date(now - 14 * DAY).toISOString(),
    stuckBefore: new Date(now - STUCK_AFTER_MINUTES * 60 * 1000).toISOString(),
    today: new Date(now).toISOString().slice(0, 10),
  };
}

function tail(text: string | null | undefined, n = 240): string {
  if (!text) return "";
  const lines = text.trim().split("\n");
  const last = lines[lines.length - 1] ?? "";
  return last.length > n ? `${last.slice(0, n)}…` : last;
}

export default async function BriefPage() {
  const supabase = await createClient();
  const { since24h, since7d, since14d, stuckBefore, today } = windows();

  const [
    { data: decisions },
    { data: blocked },
    { data: mine },
    { data: reviews },
    { data: flagged },
    { data: completed },
    { data: fires },
    { data: publisherRuns },
    { data: stuckPosts },
    { data: publisherRow },
  ] = await Promise.all([
    // Needs a decision: held work and anything waiting on someone.
    supabase
      .from("tasks")
      .select("id, title, owner, autonomy_level, recommendation, default_if_approved, due_date, client_id, clients(name), client_stages(stages(name))")
      .neq("status", "done")
      .or("owner.in.(CLAUDE_APPROVAL,WAITING),autonomy_level.eq.hold")
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(50),
    supabase
      .from("client_stages")
      .select("id, status, next_action, evidence, stages(name), client_pipelines!inner(client_id, clients(name), pipelines(name))")
      .eq("status", "blocked")
      .limit(50),
    // Mine: TOM tasks due today or overdue, then the rest.
    supabase
      .from("tasks")
      .select("id, title, due_date, key, notes, client_id, clients(name), client_stages(stages(name))")
      .eq("owner", "TOM")
      .neq("status", "done")
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(50),
    // Decisions the worker raised (disavow, blend, and the like) and reports
    // waiting to be sent. Pipeline completions are finished, flagged
    // summaries and show under "done, review if you want".
    supabase
      .from("tasks")
      .select("id, title, key, notes, created_at, client_id, clients(name)")
      .neq("status", "done")
      .or("and(title.like.Review %,key.is.null),key.eq.report_send")
      .order("created_at", { ascending: false })
      .limit(50),
    // Done, review if you want: run+flag work closed in the last week.
    supabase
      .from("tasks")
      .select("id, title, recommendation, completed_at, client_id, clients(name), client_stages(stages(name))")
      .eq("flagged_for_review", true)
      .eq("status", "done")
      .gte("completed_at", since7d)
      .order("completed_at", { ascending: false })
      .limit(50),
    // What happened: stages completed in the last day, with their evidence.
    supabase
      .from("client_stages")
      .select("id, completed_at, evidence, stages(name), client_pipelines!inner(client_id, clients(name), pipelines(name))")
      .eq("status", "complete")
      .gte("completed_at", since24h)
      .order("completed_at", { ascending: false })
      .limit(50),
    supabase
      .from("worker_fires")
      .select("id, reason, created_at, client_id, clients(name)")
      .gte("created_at", since24h)
      .order("created_at", { ascending: false })
      .limit(100),
    // Publishing (0046): Business Profile posts the publisher could not
    // publish and that need a person, and posts stuck mid-publish.
    supabase
      .from("publisher_runs")
      .select("id, post_id, client_id, outcome, transient, detail, created_at, task_id, social_posts(copy, publish_status, clients(name))")
      .not("outcome", "in", "(reminder_opened,reminder_closed)")
      .gte("created_at", since14d)
      .order("id", { ascending: false })
      .limit(200),
    supabase
      .from("social_posts")
      .select("id, client_id, copy, last_attempt_at, publish_attempts, clients(name)")
      .eq("publish_status", "publishing")
      .lt("last_attempt_at", stuckBefore)
      .limit(50),
    supabase.from("app_settings").select("value").eq("key", "publisher").maybeSingle(),
  ]);

  const dueNow = (mine ?? []).filter((t) => t.due_date && t.due_date <= today);
  const later = (mine ?? []).filter((t) => !t.due_date || t.due_date > today);
  const decisionCount = (decisions?.length ?? 0) + (blocked?.length ?? 0);
  // A post published since (by a later run or a retry) drops off.
  const publishing = needsAttention(latestPerPost(publisherRuns ?? [])).filter(
    (r) => r.social_posts?.publish_status !== "published"
  );
  const publisherSettings = parsePublisherSettings(publisherRow?.value);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 flex-wrap">
        <h1 className="page-title kicker">Brief</h1>
        <span className="text-sm text-muted-foreground">
          {decisionCount} need a decision · {dueNow.length} due · {reviews?.length ?? 0} to review or send ·{" "}
          {completed?.length ?? 0} stages finished in the last day
        </span>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* ── Needs a decision ─────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Needs a decision</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {decisionCount === 0 && <p className="text-muted-foreground">Nothing is waiting on you.</p>}
            {(blocked ?? []).map((cs) => (
              <div key={cs.id} className="space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={cn("text-[10px]", stageStatusStyles.blocked)}>
                    {stageStatusLabels.blocked}
                  </Badge>
                  <Link href={`/clients/${cs.client_pipelines.client_id}/foundation`} className="font-medium hover:underline">
                    {cs.client_pipelines.clients?.name}
                  </Link>
                  <span className="text-muted-foreground">
                    {cs.client_pipelines.pipelines?.name} › {cs.stages?.name}
                  </span>
                </div>
                <p className="text-xs">{cs.next_action ?? tail(cs.evidence)}</p>
                <p className="text-[11px] text-muted-foreground">
                  Retry by setting the stage back to Not started on the Foundation tab once this is dealt with.
                </p>
              </div>
            ))}
            {(decisions ?? []).map((t) => (
              <div key={t.id} className="space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-[10px]">{ownerLabels[t.owner]}</Badge>
                  <Link href={`/clients/${t.client_id}`} className="font-medium hover:underline">
                    {t.clients?.name}
                  </Link>
                  <span>{t.title}</span>
                  {t.client_stages?.stages?.name && (
                    <span className="text-xs text-muted-foreground">{t.client_stages.stages.name}</span>
                  )}
                </div>
                {t.recommendation && (
                  <p className="text-xs">
                    <span className="text-muted-foreground">Recommendation: </span>
                    {t.recommendation}
                    {t.default_if_approved && (
                      <span className="text-muted-foreground"> · default if approved: {t.default_if_approved}</span>
                    )}
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        {/* ── Mine ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Mine
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {dueNow.length} due or overdue · {later.length} without a date or later ·{" "}
                <Link href="/tasks?owner=TOM" className="text-primary hover:underline">all</Link>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {(mine ?? []).length === 0 && <p className="text-muted-foreground">No open tasks.</p>}
            {[...dueNow, ...later.slice(0, Math.max(0, 15 - dueNow.length))].map((t) => (
              <div key={t.id} className="flex items-center gap-2 flex-wrap">
                <Link href={`/clients/${t.client_id}`} className="text-xs text-muted-foreground hover:underline">
                  {t.clients?.name}
                </Link>
                <span>{t.title}</span>
                {t.client_stages?.stages?.name && (
                  <span className="text-xs text-muted-foreground">{t.client_stages.stages.name}</span>
                )}
                {t.due_date && (
                  <span className={cn("ml-auto text-xs", t.due_date <= today ? "text-red-700" : "text-muted-foreground")}>
                    {t.due_date}
                  </span>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        {/* ── Review or send ───────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Decide or send</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {(reviews ?? []).length === 0 && (
              <p className="text-muted-foreground">No decisions or reports waiting.</p>
            )}
            {(reviews ?? []).map((t) => (
              <div key={t.id} className="space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link
                    href={`/clients/${t.client_id}/${t.key === "report_send" ? "reports" : "foundation"}`}
                    className="font-medium hover:underline"
                  >
                    {t.clients?.name}
                  </Link>
                  <span>{t.title}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{ago(t.created_at)}</span>
                </div>
                {t.notes && <p className="text-xs text-muted-foreground">{tail(t.notes)}</p>}
              </div>
            ))}
          </CardContent>
        </Card>

        {/* ── Done, review if you want ─────────────────────────────── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Done, review if you want
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                run + flag work closed this week ·{" "}
                <Link href="/tasks?flagged=1" className="text-primary hover:underline">all flagged</Link>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {(flagged ?? []).length === 0 && <p className="text-muted-foreground">Nothing flagged this week.</p>}
            {(flagged ?? []).map((t) => (
              <div key={t.id} className="space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link href={`/clients/${t.client_id}`} className="font-medium hover:underline">
                    {t.clients?.name}
                  </Link>
                  <span>{t.title}</span>
                  {t.client_stages?.stages?.name && (
                    <span className="text-xs text-muted-foreground">{t.client_stages.stages.name}</span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">{ago(t.completed_at)}</span>
                </div>
                {t.recommendation && <p className="text-xs text-muted-foreground">{t.recommendation}</p>}
              </div>
            ))}
          </CardContent>
        </Card>

        {/* ── Publishing (Business Profile, 0046) ───────────────────── */}
        <Card className="xl:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Publishing
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                Business Profile publisher{" "}
                {publisherSettings.enabled
                  ? `on for ${publisherSettings.clients.length} client${publisherSettings.clients.length === 1 ? "" : "s"}`
                  : "switched off"}{" "}
                · <Link href="/settings#publisher" className="text-primary hover:underline">settings</Link>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {publishing.length === 0 && (stuckPosts ?? []).length === 0 && (
              <p className="text-muted-foreground">No post is blocked, failed or stuck.</p>
            )}
            {(stuckPosts ?? []).map((p) => (
              <div key={p.id} className="space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-[10px] bg-red-100 text-red-800">Stuck</Badge>
                  <Link href={`/clients/${p.client_id}/social/${p.id}`} className="font-medium hover:underline">
                    {p.clients?.name}
                  </Link>
                  <span className="min-w-0 truncate text-muted-foreground">{tail(p.copy, 80)}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{ago(p.last_attempt_at)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Publishing without a confirmed answer from Google (attempt {p.publish_attempts}); the next run checks the
                  profile and records it only on exactly one safe match.
                </p>
              </div>
            ))}
            {publishing.map((r) => {
              const o = outcomeLabels[r.outcome] ?? { label: r.outcome, className: "" };
              return (
                <div key={r.id} className="space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className={cn("text-[10px]", o.className)}>{o.label}</Badge>
                    <Link href={`/clients/${r.client_id}/social/${r.post_id}`} className="font-medium hover:underline">
                      {r.social_posts?.clients?.name}
                    </Link>
                    <span className="min-w-0 truncate text-muted-foreground">{tail(r.social_posts?.copy, 80)}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{ago(r.created_at)}</span>
                  </div>
                  <p className="text-xs">
                    {r.detail}
                    {r.task_id && (<> · <Link href={`/tasks/${r.task_id}`} className="text-primary hover:underline">task</Link></>)}
                  </p>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* ── What happened ────────────────────────────────────────── */}
        <Card className="xl:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Last 24 hours
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {completed?.length ?? 0} stages completed · {fires?.length ?? 0} worker runs started
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-2 text-sm">
            <div className="space-y-2">
              {(completed ?? []).length === 0 && <p className="text-muted-foreground">No stages completed.</p>}
              {(completed ?? []).map((cs) => (
                <div key={cs.id} className="space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className={cn("text-[10px]", stageStatusStyles.complete)}>
                      {stageStatusLabels.complete}
                    </Badge>
                    <Link href={`/clients/${cs.client_pipelines.client_id}/foundation`} className="font-medium hover:underline">
                      {cs.client_pipelines.clients?.name}
                    </Link>
                    <span className="text-muted-foreground">
                      {cs.client_pipelines.pipelines?.name} › {cs.stages?.name}
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground">{ago(cs.completed_at)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{tail(cs.evidence)}</p>
                </div>
              ))}
            </div>
            <div className="space-y-1">
              {(fires ?? []).length === 0 && <p className="text-muted-foreground">No worker runs.</p>}
              {(fires ?? []).map((f) => (
                <div key={f.id} className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground w-16 shrink-0">{ago(f.created_at)}</span>
                  <Link href={`/clients/${f.client_id}/foundation`} className="hover:underline">
                    {f.clients?.name}
                  </Link>
                  <span className="text-muted-foreground">{f.reason}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
