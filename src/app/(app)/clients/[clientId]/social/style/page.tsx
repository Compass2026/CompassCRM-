import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { AnalyzeButton, LearningToggle, ReviewPanel } from "@/components/social-style/controls";
import {
  confidenceTone, readProfile, shortDate, statusLabels, STYLE_INFLUENCE, STYLE_PROFILE_COLUMNS, traitViews,
  type ExamplePost, type StyleProfileRow,
} from "@/lib/social-style";
import { cn } from "@/lib/utils";

// Social › Style (Social History SH2): the client's proposed and approved
// Social Style Profiles, learned from their own imported Facebook history.
// Style and performance evidence only, never factual grounding; a profile
// becomes the client's only when a teammate approves it, and nothing reads
// one yet (the AI Drafter is wired in SH3).

const HISTORY_COLUMNS = "id, platform_post_id, published_at, copy, format, permalink, origin, learning_status, learning_note, is_paid, is_owner, missing_since, reach, reactions, comments, shares";

export default async function SocialStylePage({ params, searchParams }: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ v?: string }>;
}) {
  const { clientId } = await params;
  const { v } = await searchParams;
  const supabase = await createClient();
  const { data: client } = await supabase.from("clients").select("id, name").eq("id", clientId).maybeSingle();
  if (!client) notFound();

  const [{ data: profileRows }, { data: historyRows }, { data: learnableRows }, { data: members }] = await Promise.all([
    supabase.from("social_history_style_profiles").select(STYLE_PROFILE_COLUMNS).eq("client_id", clientId).eq("platform", "facebook").order("version", { ascending: false }),
    supabase.from("social_history_post_latest").select(HISTORY_COLUMNS).eq("client_id", clientId).eq("platform", "facebook").order("published_at", { ascending: false }),
    supabase.from("social_history_learnable_posts").select("id").eq("client_id", clientId).eq("platform", "facebook"),
    supabase.from("team_members").select("id, name"),
  ]);
  const profiles = (profileRows ?? []) as unknown as StyleProfileRow[];
  const history = historyRows ?? [];
  const learnable = new Set((learnableRows ?? []).map((r) => r.id));
  const names = new Map((members ?? []).map((m) => [m.id, m.name]));
  const approved = profiles.find((p) => p.status === "approved") ?? null;
  const proposed = profiles.find((p) => p.status === "proposed") ?? null;
  const shown = profiles.find((p) => String(p.version) === v) ?? proposed ?? approved ?? profiles[0] ?? null;
  const prof = shown ? readProfile(shown.profile) : null;
  const traits = shown ? traitViews(shown.profile) : [];

  const example = (e: ExamplePost, role: string) => (
    <li key={`${role}-${e.post_id}`} className="space-y-2 rounded-md border p-3" data-example={role} data-post={e.post_id}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{shortDate(e.published_at)}</span><span>·</span><span>{e.format}</span><span>·</span><span>{e.category.replace(/_/g, " ")}</span>
        {e.metrics?.lift != null && <Badge variant="outline">{e.metrics.lift}× own baseline</Badge>}
        {e.permalink && <a href={e.permalink} target="_blank" rel="noreferrer" className="ml-auto underline underline-offset-2">On Facebook</a>}
      </div>
      <p className="whitespace-pre-line text-sm">{e.masked_copy || <span className="italic text-muted-foreground">No caption</span>}</p>
      <ul className="list-disc pl-5 text-xs text-muted-foreground">{e.why.map((w) => <li key={w}>{w}</li>)}</ul>
      {e.metrics && (
        <p className="text-xs text-muted-foreground">
          Reach {e.metrics.reach ?? "—"} · reactions {e.metrics.reactions ?? "—"} · comments {e.metrics.comments ?? "—"} · shares {e.metrics.shares ?? "—"}
          {e.metrics.engagement_per_reach != null ? ` · ${(e.metrics.engagement_per_reach * 100).toFixed(1)}% engagement per reach` : " · engagement per reach unavailable"}
        </p>
      )}
    </li>
  );

  return (
    <div className="space-y-6">
      <div className="surface space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-base font-semibold">Social style — Facebook</h1>
          <Link href={`/clients/${clientId}/social`} className="ml-auto text-xs underline underline-offset-2">Back to Social</Link>
        </div>
        <p className="text-sm text-muted-foreground">
          How {client.name} writes on its own Facebook Page and what performs against its own history, learned from the
          imported posts. Style and performance evidence only: no example, phrase or number here is a fact Compass may state.
          Facts come only from Client Intelligence. Masked spans ([price/offer], [place not approved], …) are what Compass
          cannot say without a usable claim or an approved location.
        </p>
        <p className="text-xs" data-summary>
          {history.length} imported · {learnable.size} learnable ·{" "}
          {approved ? <>approved profile v{approved.version} ({shortDate(approved.reviewed_at)}{approved.reviewed_by ? `, ${names.get(approved.reviewed_by) ?? "a teammate"}` : ""})</> : "no approved profile"}
          {proposed ? <> · proposal v{proposed.version} waiting for review</> : null}
          {" · "}the AI Drafter does not read profiles yet
        </p>
        <AnalyzeButton clientId={clientId} label={profiles.length ? "Run the analysis again" : "Analyze the imported history"} />
      </div>

      {profiles.length > 1 && (
        <nav className="flex flex-wrap gap-2 text-xs" data-versions>
          {profiles.map((p) => (
            <Link key={p.id} href={`/clients/${clientId}/social/style?v=${p.version}`}
              className={cn("rounded-full border px-2 py-0.5", shown?.id === p.id ? "bg-foreground text-background" : "hover:bg-muted")}>
              v{p.version} · {p.status}
            </Link>
          ))}
        </nav>
      )}

      {!shown || !prof ? (
        <div className="surface p-4 text-sm text-muted-foreground">No analysis yet. Import the client&apos;s history, then analyze it.</div>
      ) : (
        <>
          <section className="surface space-y-3 p-4" data-profile={shown.id} data-status={shown.status}>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">Profile v{shown.version}</h2>
              <Badge variant="outline" data-status-badge>{statusLabels[shown.status]}</Badge>
              <span className="text-xs text-muted-foreground">
                {shown.analyzer_version} · data as of {shortDate(shown.as_of)} · {shown.posts_voice} voice posts of {shown.posts_learnable} learnable · {shown.posts_performance} with performance
              </span>
            </div>
            {shown.review_note && <p className="text-xs">Review note: {shown.review_note}</p>}
            <p className="text-xs text-muted-foreground">{prof.boundary}</p>
            <p className="text-xs" data-influence-rule>
              <span className="font-medium">Style, never strategy.</span> Once approved, this profile may shape only{" "}
              {STYLE_INFLUENCE.join(", ")}. Content mix, cadence, media mix and performance by category are descriptive
              only: they never override Authority topic selection, search-intent coverage, service priorities,
              E-E-A-T and evidence needs, or Content Planner strategy.
            </p>
            {shown.status === "proposed" && <ReviewPanel clientId={clientId} profileId={shown.id} profileHash={shown.profile_hash} />}
            <p className="break-all text-[11px] text-muted-foreground">Profile hash {shown.profile_hash}</p>
          </section>

          <section className="surface space-y-3 p-4" data-traits>
            <h2 className="text-sm font-semibold">Traits</h2>
            <ul className="divide-y">
              {traits.map((t) => (
                <li key={t.key} className="grid gap-1 py-2 md:grid-cols-[200px_1fr]" data-trait={t.key} data-confidence={t.confidence}>
                  <div className="flex items-start gap-2 text-sm font-medium">
                    {t.label}
                    <Badge variant="outline" className={confidenceTone[t.confidence]}>{t.confidence}</Badge>
                    {t.descriptive && <Badge variant="outline" data-descriptive>descriptive only</Badge>}
                  </div>
                  <div className="space-y-0.5 text-sm">
                    {t.lines.map((l) => <p key={l}>{l}</p>)}
                    <p className="text-xs text-muted-foreground">{t.n != null ? `n = ${t.n}. ` : ""}{t.basis}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="surface space-y-3 p-4">
            <h2 className="text-sm font-semibold">Representative posts ({prof.representative.length})</h2>
            <p className="text-xs text-muted-foreground">The client&apos;s normal voice, closest to the centre for each main kind of post. The drafter will learn from these by example.</p>
            <ul className="space-y-3">{prof.representative.map((e) => example(e, "representative"))}</ul>
          </section>

          <section className="surface space-y-3 p-4">
            <h2 className="text-sm font-semibold">Top performers ({prof.topPerformers.length})</h2>
            <p className="text-xs text-muted-foreground">Engagement per reach at least 1.25× the client&apos;s own baseline for the format, at most one a week, outliers and do-not-learn posts left out.</p>
            {prof.topPerformers.length ? <ul className="space-y-3">{prof.topPerformers.map((e) => example(e, "top"))}</ul>
              : <p className="text-sm text-muted-foreground">None: no post clears the bar, or reach is unavailable.</p>}
          </section>

          <section className="surface space-y-3 p-4">
            <h2 className="text-sm font-semibold">Outliers ({prof.outliers.length})</h2>
            <p className="text-xs text-muted-foreground">Unusually high reach or engagement. They inform the performance patterns; they never define the voice.</p>
            {prof.outliers.length ? <ul className="space-y-3">{prof.outliers.map((e) => example(e, "outlier"))}</ul>
              : <p className="text-sm text-muted-foreground">None.</p>}
          </section>

          <section className="surface space-y-3 p-4" data-do-not-learn>
            <h2 className="text-sm font-semibold">Do not learn ({prof.doNotLearnPosts.length} posts)</h2>
            <ul className="divide-y text-sm">
              {prof.doNotLearnPosts.map((d) => (
                <li key={d.post_id} className="space-y-1 py-2" data-dnl={d.post_id}>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{shortDate(d.published_at)}</span><span>·</span><span>{d.format}</span>
                    {d.permalink && <a href={d.permalink} target="_blank" rel="noreferrer" className="ml-auto underline underline-offset-2">On Facebook</a>}
                  </div>
                  <p>{d.opening || <span className="italic text-muted-foreground">No caption</span>}</p>
                  <ul className="list-disc pl-5 text-xs text-muted-foreground">{d.reasons.map((r) => <li key={r.code}>{r.detail}</li>)}</ul>
                </li>
              ))}
            </ul>
            <h3 className="pt-2 text-sm font-semibold">Phrases never to learn</h3>
            <ul className="space-y-2 text-sm">
              {prof.doNotLearnPhrases.map((p) => (
                <li key={p.category} data-phrase={p.category}>
                  <span className="font-medium">{p.label}</span> <span className="text-xs text-muted-foreground">({p.posts} posts)</span>:{" "}
                  {p.examples.map((x) => `"${x.text}"`).join(", ")}
                  <p className="text-xs text-muted-foreground">{p.why}</p>
                </li>
              ))}
            </ul>
          </section>

          {prof.notes.length > 0 && (
            <section className="surface space-y-1 p-4 text-xs text-muted-foreground">
              {prof.notes.map((n) => <p key={n}>{n}</p>)}
            </section>
          )}
        </>
      )}

      <section className="surface space-y-3 p-4" data-history>
        <h2 className="text-sm font-semibold">Imported posts ({history.length})</h2>
        <p className="text-xs text-muted-foreground">
          Exclude a post that should not shape the voice (an ended offer, an outdated claim, a one-off). Compass-generated,
          paid and other-author posts are never learnable. Changes apply to the next analysis.
        </p>
        <ul className="divide-y">
          {history.map((h) => {
            const isLearnable = learnable.has(h.id);
            const locked = h.origin === "compass" || h.is_paid || h.is_owner === false;
            return (
              <li key={h.id} className="grid gap-2 py-2 md:grid-cols-[1fr_auto]" data-history-post={h.id} data-learnable={isLearnable ? "yes" : "no"}>
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{shortDate(h.published_at)}</span><span>·</span><span>{h.format}</span>
                    {h.reach != null && <span>· reach {h.reach}</span>}
                    {!isLearnable && <Badge variant="outline">not learnable{h.origin === "compass" ? " · Compass" : h.learning_status === "excluded" ? " · excluded" : ""}</Badge>}
                    {h.permalink && <a href={h.permalink} target="_blank" rel="noreferrer" className="underline underline-offset-2">On Facebook</a>}
                  </div>
                  <p className="line-clamp-2 text-sm">{h.copy || <span className="italic text-muted-foreground">No caption</span>}</p>
                  {h.learning_note && <p className="text-xs text-muted-foreground">Note: {h.learning_note}</p>}
                </div>
                <LearningToggle clientId={clientId} postId={String(h.id)} status={h.learning_status ?? "included"} locked={locked} />
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
