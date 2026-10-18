import { blogClient } from "@/lib/blog-publications";
import { BlogPublicationControls } from "@/components/drafts/blog-publication-controls";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isUuid, formatStamp, actorName } from "@/lib/tasks";
import { listTeamMembers } from "@/lib/team";
import { draftActions, draftStatusLabels, isDraftStatus } from "@/lib/content-drafts";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { MarkdownPreview } from "@/components/drafts/markdown-preview";
import { CopyMarkdownButton } from "@/components/drafts/copy-markdown";
import { DraftSteps, EditDraftForm, RegenerateForm, ReviewDraftForms } from "@/components/drafts/draft-forms";
import { HeroPicker, type HeroOption } from "@/components/drafts/hero-picker";
import { BRAND_BUCKET, SIGNED_URL_TTL } from "@/lib/brand";
import { toMarkdown } from "../../../../../../../supabase/functions/content-drafter/markdown.ts";
import { heroProblems, HERO_KINDS, HERO_MIME, ILLUSTRATIVE_LABEL } from "../../../../../../../supabase/functions/content-drafter/hero.ts";
import { TLDR_LABEL } from "../../../../../../../supabase/functions/content-drafter/tldr.ts";

export const dynamic = "force-dynamic";

type Outline = { level: number; heading: string }[];
type Links = { url: string; anchor: string; reason?: string }[];
type Cta = { text?: string; url?: string | null };
type Lint = { problems?: { code: string; message: string }[]; warnings?: { code: string; message: string }[] } | null;

// One blog / web page draft (0067): the brief it answers, the article, the
// claims it stands on, its review, and Copy / Download Markdown. Every read
// is the teammate's own (is_team()).
export default async function DraftPage({ params }: { params: Promise<{ clientId: string; draftId: string }> }) {
  const { clientId, draftId } = await params;
  if (!isUuid(clientId) || !isUuid(draftId)) notFound();
  const supabase = await createClient();
  const { data: d } = await supabase.from("content_drafts").select("*").eq("id", draftId).eq("client_id", clientId).maybeSingle();
  if (!d || !isDraftStatus(d.status)) notFound();

  const { data: publications } = await blogClient(supabase).from("blog_publications").select("id,draft_version,status,scheduled_at,published_url,last_error").eq("draft_id", draftId).order("released_at", { ascending: false });
  const [members, { data: linked }, { data: claims }, { data: service }, { data: finalPost }, { data: problems }] = await Promise.all([
    listTeamMembers(supabase),
    supabase.from("content_draft_claims").select("claim_id, claims(id, claim, status, source)").eq("draft_id", draftId),
    supabase.from("claims").select("id, claim, status, source").eq("client_id", clientId).order("created_at"),
    d.service_id ? supabase.from("services").select("name, page_url").eq("id", d.service_id).maybeSingle() : Promise.resolve({ data: null }),
    d.final_content_post_id ? supabase.from("content_posts").select("id, title, status, url").eq("id", d.final_content_post_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.rpc("content_draft_problems_for", { p_draft_id: draftId }),
  ]);
  // Hero image (20261015210000): the client's stored, hashed photos and
  // social graphics, plus the current hero even if it no longer qualifies.
  const isBlog = d.deliverable === "blog";
  const { data: assetRows } = isBlog
    ? await supabase.from("brand_assets")
        .select("id, client_id, kind, label, notes, source, storage_path, content_hash, mime_type, width, height, size_bytes, file_name")
        .eq("client_id", clientId).in("kind", [...HERO_KINDS]).in("mime_type", [...HERO_MIME])
        .not("storage_path", "is", null).not("content_hash", "is", null).order("created_at", { ascending: false })
    : { data: [] };
  const { data: heroRow } = d.hero_asset_id && !(assetRows ?? []).some((a) => a.id === d.hero_asset_id)
    ? await supabase.from("brand_assets")
        .select("id, client_id, kind, label, notes, source, storage_path, content_hash, mime_type, width, height, size_bytes, file_name")
        .eq("id", d.hero_asset_id).maybeSingle()
    : { data: null };
  const heroAssets = [...(assetRows ?? []), ...(heroRow ? [heroRow] : [])];
  const heroPaths = heroAssets.map((a) => a.storage_path).filter((p): p is string => !!p);
  const { data: signed } = heroPaths.length
    ? await supabase.storage.from(BRAND_BUCKET).createSignedUrls(heroPaths, SIGNED_URL_TTL)
    : { data: [] };
  const signedUrl = new Map((signed ?? []).filter((x) => x.path && x.signedUrl).map((x) => [x.path!, x.signedUrl]));
  const hero = heroAssets.find((a) => a.id === d.hero_asset_id) ?? null;
  const heroUrl = hero?.storage_path ? signedUrl.get(hero.storage_path) ?? null : null;
  const heroIssues = hero ? heroProblems(hero, clientId) : d.hero_asset_id ? ["The hero image is no longer available."] : [];
  const heroOptions: HeroOption[] = (assetRows ?? []).map((a) => ({
    id: a.id, label: a.label, kind: a.kind, width: a.width, height: a.height,
    preview: a.storage_path ? signedUrl.get(a.storage_path) ?? null : null,
  }));
  const names = new Map(members.map((m) => [m.id, m.name]));
  const status = draftStatusLabels[d.status];
  const actions = draftActions(d);
  const outline = (Array.isArray(d.outline) ? d.outline : []) as Outline;
  const links = (Array.isArray(d.internal_links) ? d.internal_links : []) as Links;
  const cta = (d.cta ?? {}) as Cta;
  const lint = d.lint as Lint;
  const usable = (claims ?? []).filter((c) => c.status === "confirmed" || (c.status === "sourced" && (c.source ?? "").trim() !== ""));
  const linkedIds = (linked ?? []).map((l) => l.claim_id);
  const notReady = (problems as string[] | null) ?? [];
  const markdown = d.title ? toMarkdown({ ...d, cta }) : "";
  const kind = d.deliverable === "blog" ? "Blog" : "Web page";
  // The TL;DR (tldr.ts): required for blogs whose brief carries the rule; older drafts keep their review unchanged.
  const tldr = (d.tldr ?? "").trim();
  const tldrRequired = isBlog && !!(d.brief as { tldr?: { required?: boolean } } | null)?.tldr?.required;

  return (
    <div className="max-w-4xl space-y-6" data-draft={d.status}>
      <div className="space-y-1">
        <Link href={`/clients/${clientId}/planner`} className="text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-primary">&larr; Planner</Link>
        <h2 className="text-lg font-semibold [overflow-wrap:anywhere]">{d.title ?? d.topic}</h2>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline" className={cn("text-[10px]", status.className)} data-draft-status>{status.label}</Badge>
          <span>{kind}{d.page_type ? ` · ${d.page_type.replace(/_/g, " ")}` : ""}</span>
          <span>· version {d.version}</span>
          {d.author_kind && <span>· {d.author_kind === "drafter" ? `written by the drafter${d.runtime ? ` (${d.runtime})` : ""}` : "edited by the team"}</span>}
          {d.word_count != null && <span>· {d.word_count} words</span>}
        </div>
      </div>

      {d.status === "requested" && (
        <p className="surface p-4 text-sm" data-draft-waiting>
          The drafter is writing this {kind.toLowerCase()}. It appears here for review when it is done (usually within a few minutes);
          reload to check.
        </p>
      )}
      {d.status === "rejected" && d.review_note && (
        <p role="note" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          Rejected by {actorName(d.reviewed_by, names)}: “{d.review_note}”
        </p>
      )}
      {d.status === "approved" && (
        <p className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-900" data-draft-approved>
          Approved by {actorName(d.reviewed_by, names)}{d.reviewed_at ? ` on ${formatStamp(d.reviewed_at)}` : ""} (version {d.approved_version}).{" "}
          {finalPost ? <>Final article: <Link href={`/clients/${clientId}/content`} className="underline">{finalPost.title}</Link> ({finalPost.status}).</> : null}
        </p>
      )}

      {d.deliverable === "blog" && <BlogPublicationControls draftId={draftId} clientId={clientId} version={d.version} approved={d.status === "approved"} publications={publications ?? []} />}
      <section className="surface space-y-2 p-4 text-sm" data-draft-brief>
        <h3 className="font-semibold">Brief</h3>
        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-y-1 text-xs [&>dd]:[overflow-wrap:anywhere]">
          <dt className="text-muted-foreground">Topic</dt><dd>{d.topic}</dd>
          {d.primary_keyword && (<><dt className="text-muted-foreground">Primary keyword</dt><dd>{d.primary_keyword}</dd></>)}
          {d.search_intent && (<><dt className="text-muted-foreground">Search intent</dt><dd>{d.search_intent}</dd></>)}
          {service && (<><dt className="text-muted-foreground">Service page</dt><dd>{service.name}{service.page_url ? ` · ${service.page_url}` : ""}</dd></>)}
          {d.authority_opportunity_id && (<><dt className="text-muted-foreground">Authority</dt><dd><Link href={`/clients/${clientId}/authority`} className="underline">opportunity</Link></dd></>)}
          {d.request_note && (<><dt className="text-muted-foreground">Note</dt><dd>{d.request_note}</dd></>)}
        </dl>
      </section>

      {d.title && (
        <div className={cn("grid gap-4", isBlog && "lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start")}>
        <section className="surface min-w-0 space-y-3 p-4" data-draft-article>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Article</h3>
            {actions.includes("export") && (
              <div className="ml-auto flex flex-wrap gap-2">
                <CopyMarkdownButton markdown={markdown} />
                <a href={`/clients/${clientId}/drafts/${draftId}/markdown?download=1`} className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted" data-download-markdown>
                  Download .md
                </a>
              </div>
            )}
          </div>
          <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-y-1 text-xs [&>dd]:[overflow-wrap:anywhere]">
            <dt className="text-muted-foreground">Slug</dt><dd className="font-mono">/{d.slug}</dd>
            <dt className="text-muted-foreground">Meta title</dt><dd>{d.meta_title} <span className="text-muted-foreground">({(d.meta_title ?? "").length})</span></dd>
            <dt className="text-muted-foreground">Meta description</dt><dd>{d.meta_description} <span className="text-muted-foreground">({(d.meta_description ?? "").length})</span></dd>
            <dt className="text-muted-foreground">Outline</dt>
            <dd><ul className="space-y-0.5">{outline.map((o, i) => <li key={i} className={o.level === 3 ? "pl-4" : ""}>{o.heading}</li>)}</ul></dd>
          </dl>
          <div className="rounded-md border p-4">
            <h1 className="mb-3 text-xl font-semibold [overflow-wrap:anywhere]" data-draft-h1>{d.h1}</h1>
            {tldr ? (
              <aside className="mb-4 rounded-md border-l-4 border-primary bg-muted/60 px-3 py-2 text-sm" data-draft-tldr>
                <p className="text-xs font-semibold uppercase tracking-wide text-primary">{TLDR_LABEL}</p>
                <p className="mt-1 [overflow-wrap:anywhere]">{tldr}</p>
              </aside>
            ) : tldrRequired ? (
              <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-draft-tldr-missing>
                This blog needs a {TLDR_LABEL} under the title before it can be submitted or approved.
              </p>
            ) : null}
            <MarkdownPreview markdown={d.body_markdown ?? ""} />
            {cta.text && <p className="mt-4 text-sm font-medium">{cta.url ? <a href={cta.url} className="underline" target="_blank" rel="noreferrer">{cta.text}</a> : cta.text}</p>}
          </div>
          {links.length > 0 && (
            <div className="text-xs">
              <p className="font-medium">Internal-link recommendations</p>
              <ul className="mt-1 space-y-0.5">
                {links.map((l, i) => <li key={i} className="[overflow-wrap:anywhere]">“{l.anchor}” → {l.url}{l.reason ? <span className="text-muted-foreground"> · {l.reason}</span> : null}</li>)}
              </ul>
            </div>
          )}
        </section>
        {isBlog && (
          <aside className="surface space-y-3 p-4 lg:sticky lg:top-4 lg:order-none order-first" data-draft-hero>
            <h3 className="text-sm font-semibold">Hero image</h3>
            {hero ? (
              <figure className="space-y-2" data-hero-current>
                {heroUrl
                  ? // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                    <img src={heroUrl} alt={d.hero_alt ?? ""} width={hero.width ?? undefined} height={hero.height ?? undefined}
                      className="h-auto w-full rounded-md border bg-muted" data-hero-preview />
                  : <p className="text-xs text-muted-foreground">The stored file could not be previewed.</p>}
                {hero.kind === "social_post" && (
                  <p className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900" data-hero-illustrative>
                    {ILLUSTRATIVE_LABEL}
                  </p>
                )}
                <figcaption className="space-y-1 text-xs">
                  <span className="block"><span className="text-muted-foreground">Alt text:</span> {d.hero_alt}</span>
                  <span className="block text-muted-foreground [overflow-wrap:anywhere]" data-hero-provenance>
                    {hero.label} · {hero.kind === "social_post" ? "generated graphic (non-evidentiary)" : "photo"} · {hero.source}
                    {hero.width && hero.height ? ` · ${hero.width}×${hero.height}` : ""}
                    {hero.content_hash ? ` · sha256 ${hero.content_hash.slice(0, 12)}` : ""}
                  </span>
                  {hero.notes && <span className="block text-muted-foreground [overflow-wrap:anywhere]">{hero.notes}</span>}
                </figcaption>
              </figure>
            ) : (
              <p className="text-xs text-muted-foreground" data-hero-none>No hero image. The article publishes without one.</p>
            )}
            {heroIssues.length > 0 && (
              <ul className="list-disc rounded-md border border-amber-200 bg-amber-50 py-2 pl-6 pr-2 text-xs text-amber-900" data-hero-problems>
                {heroIssues.map((m) => <li key={m}>{m}</li>)}
              </ul>
            )}
            {actions.includes("edit") ? (
              <HeroPicker clientId={clientId} draftId={draftId} version={d.version} options={heroOptions}
                current={d.hero_asset_id} alt={d.hero_alt} illustrativeLabel={ILLUSTRATIVE_LABEL} />
            ) : (
              <p className="text-xs text-muted-foreground" data-hero-locked>
                {d.status === "in_review" ? "Withdraw the draft to change its hero image; the change needs a fresh review."
                  : d.status === "approved" ? "Approved with this hero. Reopen the draft to change it (that clears the approval)."
                  : "The hero image can be chosen once the draft is written."}
              </p>
            )}
          </aside>
        )}
        </div>
      )}

      <section className="surface space-y-2 p-4" data-draft-claims>
        <h3 className="text-sm font-semibold">Claims it stands on</h3>
        {(linked ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No claims linked.</p> : (
          <ul className="space-y-2 text-sm">
            {(linked ?? []).map((l) => l.claims && (
              <li key={l.claim_id}>
                {l.claims.claim} <span className="text-xs text-muted-foreground">({l.claims.status})</span>
                {l.claims.source && <span className="block break-all text-xs text-muted-foreground">Source: {l.claims.source}</span>}
              </li>
            ))}
          </ul>
        )}
        {(lint?.warnings ?? []).length > 0 && (
          <div className="text-xs text-muted-foreground">
            <p className="font-medium">Drafter warnings</p>
            <ul className="list-disc pl-5">{lint!.warnings!.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
          </div>
        )}
        {d.status !== "requested" && d.status !== "approved" && (notReady.length > 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-draft-problems>
            <p className="font-medium">Not ready for approval:</p>
            <ul className="mt-1 list-disc pl-5">{notReady.map((m) => <li key={m}>{m}</li>)}</ul>
          </div>
        ) : <p className="text-sm text-green-800">Grounding checks pass.</p>)}
      </section>

      <section className="surface space-y-4 p-4" data-draft-review>
        <h3 className="text-sm font-semibold">Review</h3>
        <DraftSteps clientId={clientId} draftId={draftId} status={d.status} version={d.version} actions={actions} />
        {actions.includes("approve") && <ReviewDraftForms clientId={clientId} draftId={draftId} version={d.version} ready={notReady.length === 0} />}
        {actions.includes("regenerate") && <RegenerateForm clientId={clientId} draftId={draftId} />}
      </section>

      {actions.includes("edit") && (
        <section className="surface space-y-3 p-4">
          <h3 className="text-sm font-semibold">Edit</h3>
          <EditDraftForm clientId={clientId} draftId={draftId} version={d.version} claims={usable} linked={linkedIds}
            draft={{ title: d.title, slug: d.slug, meta_title: d.meta_title, meta_description: d.meta_description, h1: d.h1, tldr: d.tldr,
                     outline, body_markdown: d.body_markdown, internal_links: links, cta }} />
        </section>
      )}
    </div>
  );
}
