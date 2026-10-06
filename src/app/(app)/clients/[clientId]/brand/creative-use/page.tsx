import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { historyLine, reviewCounts, type ReviewAsset } from "@/lib/creative-use";
import { ReviewCard } from "@/components/creative-use/review-card";
import { KITS } from "../../../../../../../supabase/functions/creative-engine/kits.ts";

// Creative use (0054 / 0055): which of the client's stored photos and logos
// the Creative Engine may use. Each decision is a teammate's; hashes come
// only from the source-assets function; AI suggestions are shown apart and
// never decide anything. Generated creative never appears here.

const COLUMNS = "id, kind, source, label, storage_path, url, width, height, content_hash, content_hashed_at, creative_use, depicts_own_work, subjects, focal_x, focal_y, creative_review_note, creative_reviewed_at, creative_suggestions, content_measurement, notes, sort_order, created_at";
const REVIEWABLE = ["photo", "logo_primary", "logo_alt", "logo_icon", "wordmark"] as const;

export default async function CreativeUsePage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const supabase = await createClient();
  const { data: client } = await supabase.from("clients").select("id, name").eq("id", clientId).maybeSingle();
  if (!client) notFound();

  const { data: rows } = await supabase.from("brand_assets").select(COLUMNS).eq("client_id", clientId)
    .in("kind", REVIEWABLE).order("kind").order("sort_order").order("created_at");
  const assets = (rows ?? []) as unknown as (ReviewAsset & { sort_order: number })[];

  const paths = assets.map((a) => a.storage_path).filter((p): p is string => !!p);
  const signed = new Map<string, string>();
  if (paths.length) {
    const { data } = await supabase.storage.from("brand-assets").createSignedUrls(paths, 3600);
    for (const r of data ?? []) if (r.path && r.signedUrl) signed.set(r.path, r.signedUrl);
  }

  const ids = assets.map((a) => a.id);
  const [{ data: events }, { data: members }] = await Promise.all([
    ids.length
      ? supabase.from("creative_governance_events").select("id, subject_id, action, actor_kind, actor_id, note, changes, created_at")
          .eq("client_id", clientId).eq("subject_type", "brand_asset").in("subject_id", ids).order("id", { ascending: false })
      : Promise.resolve({ data: [] as never[] }),
    supabase.from("team_members").select("id, name"),
  ]);
  const names = new Map((members ?? []).map((m) => [m.id, m.name]));
  const history = new Map<string, { id: number; line: string; at: string }[]>();
  for (const e of events ?? []) {
    const list = history.get(e.subject_id) ?? [];
    list.push({ id: e.id, at: e.created_at, line: historyLine(e, e.actor_id ? names.get(e.actor_id) ?? null : null) });
    history.set(e.subject_id, list);
  }
  const counts = reviewCounts(assets);
  const photos = assets.filter((a) => a.kind === "photo");
  const logos = assets.filter((a) => a.kind !== "photo");

  const section = (title: string, list: typeof assets) => (
    <section className="space-y-3" data-section={title}>
      <h2 className="text-sm font-semibold">{title} ({list.length})</h2>
      {list.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
        <ul className="space-y-3">
          {list.map((a) => (
            <ReviewCard key={a.id} clientId={clientId} asset={a}
              imageUrl={a.storage_path ? signed.get(a.storage_path) ?? null : null}
              history={history.get(a.id) ?? []} />
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <div className="space-y-6">
      <div className="surface space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-base font-semibold">Creative use</h1>
          {Object.values(KITS).some((k) => k.client_id === clientId) && (
            <Link href={`/clients/${clientId}/brand/creative-preview`} className="ml-auto text-xs underline underline-offset-2" data-creative-previews>Creative previews</Link>
          )}
          <Link href={`/clients/${clientId}/brand`} className="text-xs underline underline-offset-2 [&:first-of-type]:ml-auto">Back to the brand board</Link>
        </div>
        <p className="text-sm text-muted-foreground">
          Decide which of {client.name}&apos;s stored photos and logos the Creative Engine may use. Approval needs the stored
          file&apos;s hash and size, subject tags, and for a photo whether it shows the client&apos;s own work and its focal
          point. A new file resets the review. AI suggestions are only suggestions.
        </p>
        <p className="text-xs" data-counts>
          {counts.approved} approved · {counts.excluded} excluded · {counts.unreviewed} unreviewed · {counts.hashed} of {counts.total} hashed
          {counts.linkOnly ? ` · ${counts.linkOnly} link-only` : ""}
        </p>
      </div>
      {section("Photos", photos)}
      {section("Logos", logos)}
    </div>
  );
}
