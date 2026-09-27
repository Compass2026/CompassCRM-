import { createClient } from "@/lib/supabase/server";
import {
  buildAuthorityView,
  type LatestRow,
  type Opportunity,
  type OpportunityEvent,
  type OpportunityState,
  type PillarLite,
  type RunRow,
} from "@/lib/authority-view";
import { controlsState } from "@/lib/authority-controls";
import { listTeamMembers } from "@/lib/team";
import { RECORD_KEY } from "@/lib/authority-reconcile";
import type { DraftInfo } from "@/lib/authority-draft";
import { normPath } from "../../../../../../supabase/functions/authority/urls";
import { AuthorityBanners, AuthorityHeader, AuthoritySummary } from "@/components/authority/authority-header";
import { AuthoritySections } from "@/components/authority/authority-sections";
import { AuthorityRunHistory } from "@/components/authority/authority-run-history";
import { AuthorityRunControls } from "@/components/authority/authority-run-controls";
import { AuthorityRunProvider } from "@/components/authority/authority-run-context";

// The Authority Engine's recorded runs (0048). Every read is the signed-in
// teammate's own (RLS: is_team()). The controls start a full analysis or a
// refresh (authority-run), move an opportunity through its lifecycle
// (authority_decide) and apply a decision with its client-data change
// (authority_apply, 0049), which starts a refresh afterwards.
export default async function AuthorityPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const supabase = await createClient();

  const [clientQ, latestQ, runsQ, statesQ, eventsQ, members] = await Promise.all([
    supabase.from("clients").select("status").eq("id", clientId).maybeSingle(),
    supabase.from("authority_latest").select("*").eq("client_id", clientId).maybeSingle(),
    supabase
      .from("authority_runs")
      .select("id, created_at, finished_at, status, mode, requested_via, requested_by, inventory_fetched_at, inventory_pages, inventory_errors, diff, error, health:inventory->health")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("authority_opportunity_state")
      .select("id, key, effective_status, present, first_seen_run_id, last_seen_run_id, status, suppressed, dismissed_until, status_reason, decided_by, decided_at, cycle_started_at")
      .eq("client_id", clientId),
    supabase
      .from("authority_opportunity_events")
      .select("opportunity_id, run_id, created_at, kind, actor_kind, actor_id, detail")
      .eq("client_id", clientId)
      .order("created_at", { ascending: true })
      .limit(2000),
    listTeamMembers(supabase),
  ]);

  const failure = clientQ.error ?? latestQ.error ?? runsQ.error ?? statesQ.error ?? eventsQ.error;
  let report: { opportunities: Opportunity[]; pillars: PillarLite[]; site: string | null } | null = null;
  let reportError: string | null = null;
  const latest = latestQ.data as unknown as LatestRow | null;
  if (!failure && latest?.run_id) {
    const { data, error } = await supabase
      .from("authority_runs")
      .select("opportunities:report->opportunities, pillars:report->pillars, site:inventory->>site")
      .eq("id", latest.run_id)
      .single();
    if (error) reportError = error.message;
    else report = data as unknown as { opportunities: Opportunity[]; pillars: PillarLite[]; site: string | null };
  }

  // C2: the record-content card counts what is recorded against the pages the
  // analysis still lists (content_posts' paths, and the opportunity's links).
  let recorded: { paths: string[]; linked: number } | undefined;
  const recordState = ((statesQ.data ?? []) as unknown as OpportunityState[]).find((s) => s.key === RECORD_KEY && s.present);
  if (report && recordState) {
    const [postsQ, linksQ] = await Promise.all([
      supabase.from("content_posts").select("url").eq("client_id", clientId),
      supabase.from("authority_opportunity_links").select("id", { count: "exact", head: true }).eq("opportunity_id", recordState.id).eq("kind", "content_post"),
    ]);
    recorded = {
      paths: (postsQ.data ?? []).map((p) => normPath(p.url, report!.site)).filter((x): x is string => !!x),
      linked: linksQ.count ?? 0,
    };
  }

  // 0053: Draft with AI — each Business Profile opportunity's open request
  // (orchestration only) and its linked posts (the lifecycle asset).
  let drafts: Record<string, DraftInfo> | undefined;
  const gbpStates = ((statesQ.data ?? []) as unknown as (OpportunityState & { cycle_started_at: string | null })[])
    .filter((s) => s.key.startsWith("gbp_post:") && s.present);
  if (report && gbpStates.length) {
    const [reqQ, linkQ] = await Promise.all([
      supabase.from("tasks").select("id, key, status, notes, created_at").eq("client_id", clientId)
        .like("key", "authority\\_draft:%").in("status", ["open", "in_progress", "blocked"]),
      supabase.from("authority_opportunity_links").select("opportunity_id, created_at, social_posts(id, review_status, publish_status)")
        .eq("client_id", clientId).eq("kind", "social_post"),
    ]);
    drafts = Object.fromEntries(gbpStates.map((s) => {
      const t = (reqQ.data ?? []).find((r) => r.key === `authority_draft:${s.id}`);
      const posts = ((linkQ.data ?? []) as unknown as { opportunity_id: string; created_at: string; social_posts: { id: string; review_status: string; publish_status: string } | null }[])
        .filter((l) => l.opportunity_id === s.id && l.social_posts)
        .map((l) => ({ id: l.social_posts!.id, reviewStatus: l.social_posts!.review_status, publishStatus: l.social_posts!.publish_status, linkedAt: l.created_at }));
      return [s.id, {
        request: t ? { id: t.id, status: t.status as "open" | "in_progress" | "blocked", notes: t.notes, createdAt: t.created_at } : null,
        posts, cycleStartedAt: s.cycle_started_at ?? null,
      }];
    }));
  }

  if (failure || reportError) {
    return (
      <p role="alert" className="callout border-red-200 bg-red-50 text-red-900">
        Could not load this client&apos;s Authority analysis: {failure?.message ?? reportError}.
      </p>
    );
  }

  const runs = (runsQ.data ?? []) as unknown as RunRow[];
  const now = new Date();
  const view = buildAuthorityView({
    latest,
    runs,
    now,
    opportunities: report?.opportunities ?? [],
    pillars: report?.pillars ?? [],
    states: (statesQ.data ?? []) as unknown as OpportunityState[],
    events: (eventsQ.data ?? []) as unknown as OpportunityEvent[],
    members,
    recorded,
    drafts,
  });
  const controlState = controlsState({
    clientStatus: clientQ.data?.status ?? null,
    hasCompletedRun: !!latest?.run_id,
    staleSections: latest?.stale_sections ?? [],
    inventoryStale: !!latest?.inventory_stale,
    runs,
    now,
  });
  const controls = <AuthorityRunControls clientId={clientId} state={controlState} />;

  return (
    <AuthorityRunProvider clientId={clientId} runningId={controlState.running?.id ?? null}>
      <div className="space-y-6">
        <AuthorityHeader header={view.header} controls={controls} />
        <AuthorityBanners banners={view.banners} />
        {!view.empty && <AuthoritySummary summary={view.summary} />}
        {!view.empty && (
          <AuthoritySections
            sections={view.sections}
            dismissed={view.dismissed}
            clientId={clientQ.data?.status === "offboarded" ? null : clientId}
          />
        )}
        {view.history.length > 0 && <AuthorityRunHistory rows={view.history} />}
      </div>
    </AuthorityRunProvider>
  );
}
