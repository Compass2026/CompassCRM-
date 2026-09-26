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
import { AuthorityBanners, AuthorityHeader, AuthoritySummary } from "@/components/authority/authority-header";
import { AuthoritySections } from "@/components/authority/authority-sections";
import { AuthorityRunHistory } from "@/components/authority/authority-run-history";
import { AuthorityRunControls } from "@/components/authority/authority-run-controls";

// The Authority Engine's recorded runs (0048). Every read is the signed-in
// teammate's own (RLS: is_team()). The controls start a full analysis or a
// refresh (authority-run) and move an opportunity through its lifecycle
// (authority_decide); nothing here changes client data.
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
      .select("id, key, effective_status, present, first_seen_run_id, last_seen_run_id, status, suppressed, dismissed_until, status_reason, decided_by, decided_at")
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
  let report: { opportunities: Opportunity[]; pillars: PillarLite[] } | null = null;
  let reportError: string | null = null;
  const latest = latestQ.data as unknown as LatestRow | null;
  if (!failure && latest?.run_id) {
    const { data, error } = await supabase
      .from("authority_runs")
      .select("opportunities:report->opportunities, pillars:report->pillars")
      .eq("id", latest.run_id)
      .single();
    if (error) reportError = error.message;
    else report = data as unknown as { opportunities: Opportunity[]; pillars: PillarLite[] };
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
  });
  const controls = (
    <AuthorityRunControls
      clientId={clientId}
      state={controlsState({
        clientStatus: clientQ.data?.status ?? null,
        hasCompletedRun: !!latest?.run_id,
        staleSections: latest?.stale_sections ?? [],
        inventoryStale: !!latest?.inventory_stale,
        runs,
        now,
      })}
    />
  );

  return (
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
  );
}
