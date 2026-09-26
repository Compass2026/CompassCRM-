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
import { listTeamMembers } from "@/lib/team";
import { AuthorityBanners, AuthorityHeader, AuthoritySummary } from "@/components/authority/authority-header";
import { AuthoritySections } from "@/components/authority/authority-sections";
import { AuthorityRunHistory } from "@/components/authority/authority-run-history";

// Read-only view of the Authority Engine's recorded runs (0048). Every read is
// the signed-in teammate's own (RLS: is_team()); nothing here starts a run or
// changes an opportunity.
export default async function AuthorityPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const supabase = await createClient();

  const [latestQ, runsQ, statesQ, eventsQ, members] = await Promise.all([
    supabase.from("authority_latest").select("*").eq("client_id", clientId).maybeSingle(),
    supabase
      .from("authority_runs")
      .select("id, created_at, finished_at, status, mode, requested_via, requested_by, inventory_fetched_at, inventory_pages, inventory_errors, diff, error, health:inventory->health")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("authority_opportunity_state")
      .select("id, key, effective_status, present, first_seen_run_id, last_seen_run_id")
      .eq("client_id", clientId),
    supabase
      .from("authority_opportunity_events")
      .select("opportunity_id, run_id, created_at, kind, actor_kind")
      .eq("client_id", clientId)
      .order("created_at", { ascending: true })
      .limit(2000),
    listTeamMembers(supabase),
  ]);

  const failure = latestQ.error ?? runsQ.error ?? statesQ.error ?? eventsQ.error;
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

  const view = buildAuthorityView({
    latest,
    runs: (runsQ.data ?? []) as unknown as RunRow[],
    opportunities: report?.opportunities ?? [],
    pillars: report?.pillars ?? [],
    states: (statesQ.data ?? []) as unknown as OpportunityState[],
    events: (eventsQ.data ?? []) as unknown as OpportunityEvent[],
    members,
  });

  if (view.empty) {
    return (
      <div className="space-y-6">
        <section className="surface-tint space-y-2 p-4 sm:p-6" data-empty="authority">
          <p className="eyebrow">Authority</p>
          <h2 className="text-xl font-bold tracking-tight">No Authority analysis yet</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            An analysis reads this client&apos;s governed facts, keywords and Search Console data with a read-only
            snapshot of their public site, and ranks what to fix, what content is supported and what needs a
            decision. It has not been run for this client. Analyses are started by the team; none runs on its own
            from this page.
          </p>
        </section>
        <AuthorityBanners banners={view.banners} />
        {view.history.length > 0 && <AuthorityRunHistory rows={view.history} />}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AuthorityHeader header={view.header!} />
      <AuthorityBanners banners={view.banners} />
      <AuthoritySummary summary={view.summary} />
      <AuthoritySections sections={view.sections} />
      <AuthorityRunHistory rows={view.history} />
    </div>
  );
}
