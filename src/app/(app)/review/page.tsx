import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { BRAND_BUCKET, SIGNED_URL_TTL } from "@/lib/brand";
import { isUuid } from "@/lib/tasks";
import {
  REVIEW_STAGES,
  centralDay,
  groupByStage,
  isReviewStage,
  proposeTimes,
  stageLabels,
  type QueueItem,
  type ReviewStage,
} from "@/lib/review-queue";
import { ReviewCard } from "@/components/review/review-card";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// The review queue (20261116150000): every client's Facebook and Business
// Profile posts from review to delivery in one place. Each card shows the
// final copy, the image it will carry (or why none), where it goes and when,
// and offers the decisions that stage allows: Approve & schedule, Approve
// only, Reject with feedback. Delivery stages show the provider's id, link or
// error. Nothing here publishes by itself; the publisher sends scheduled
// posts at their approved time.
export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string; stage?: string }>; // client: one id, or several comma-separated
}) {
  const sp = await searchParams;
  // One client, or a named batch of clients (comma-separated ids).
  const clientIds = [...new Set((sp.client ?? "").split(",").map((c) => c.trim()).filter(isUuid))];
  const clientFilter = clientIds.length === 1 ? clientIds[0] : null;
  const batchFilter = clientIds.length > 1 ? new Set(clientIds) : null;
  const stageFilter: ReviewStage | null = isReviewStage(sp.stage) ? sp.stage : null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("review_queue", clientFilter ? { p_client: clientFilter } : {});
  const all = ((data ?? []) as unknown as QueueItem[]).filter((i) => !batchFilter || batchFilter.has(i.client_id));
  const today = centralDay(new Date().toISOString());
  const proposed = proposeTimes(all, today);
  const groups = groupByStage(all);

  // Sign every image this page shows, per bucket, with this teammate's session
  // (storage RLS applies; nothing is made public). Creative graphics stream
  // through the post page's own route.
  const brandPaths = [...new Set(all.flatMap((i) => i.media.filter((m) => m.bucket === BRAND_BUCKET && m.storage_path).map((m) => m.storage_path!)))];
  const signed = new Map<string, string>();
  let signError: string | null = null;
  for (let k = 0; k < brandPaths.length; k += 100) {
    const { data: rows, error: e } = await supabase.storage.from(BRAND_BUCKET).createSignedUrls(brandPaths.slice(k, k + 100), SIGNED_URL_TTL);
    if (e) signError = e.message;
    for (const r of rows ?? []) if (r.path && r.signedUrl) signed.set(r.path, r.signedUrl);
  }

  const clients = [...new Map(all.map((i) => [i.client_id, i.client_name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const visible = (stageFilter ? [stageFilter] : REVIEW_STAGES).filter((s) => (groups.get(s) ?? []).length > 0);
  const batchParam = batchFilter ? clientIds.join(",") : null;
  const href = (q: { client?: string | null; stage?: string | null }) => {
    const p = new URLSearchParams();
    if (q.client ?? batchParam) p.set("client", (q.client ?? batchParam)!);
    if (q.stage) p.set("stage", q.stage);
    const s = p.toString();
    return s ? `/review?${s}` : "/review";
  };

  return (
    <div className="space-y-6" data-review-queue>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Review</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Every Facebook and Business Profile post from review to delivery. <strong>Approve &amp; schedule</strong> approves
          the post for the time shown and the publisher sends it then. <strong>Approve only</strong> never schedules or
          publishes. <strong>Reject</strong> sends it back with your feedback; the same copy or image cannot come back unchanged.
        </p>
        {error && <p role="alert" className="text-sm text-red-700">{error.message}</p>}
        {signError && <p role="alert" className="text-sm text-red-700">Images could not be signed: {signError}</p>}
      </div>

      <nav aria-label="Stages" className="flex flex-wrap gap-2 text-sm">
        <Link href={href({ client: clientFilter })} className={cn("rounded-full border px-3 py-1", !stageFilter && "bg-muted font-medium")}>
          All ({all.length})
        </Link>
        {REVIEW_STAGES.map((s) => {
          const n = (groups.get(s) ?? []).length;
          if (n === 0) return null;
          return (
            <Link key={s} href={href({ client: clientFilter, stage: s })} data-stage-filter={s}
              className={cn("rounded-full border px-3 py-1", stageFilter === s && "bg-muted font-medium")}>
              {stageLabels[s].label} ({n})
            </Link>
          );
        })}
      </nav>
      {clients.length > 1 && (
        <nav aria-label="Clients" className="flex flex-wrap gap-2 text-xs">
          <Link href={href({ client: "", stage: stageFilter })} className={cn("rounded-full border px-2 py-0.5", !clientFilter && !batchFilter && "bg-muted font-medium")}>Every client</Link>
          {clients.map(([id, name]) => (
            <Link key={id} href={href({ client: id, stage: stageFilter })} className={cn("rounded-full border px-2 py-0.5", clientFilter === id && "bg-muted font-medium")}>
              {name}
            </Link>
          ))}
        </nav>
      )}

      {visible.length === 0 && <p className="text-sm text-muted-foreground">Nothing is waiting here.</p>}
      {visible.map((s) => (
        <section key={s} className="space-y-3" data-stage={s}>
          <div>
            <h2 className="text-base font-semibold">
              {stageLabels[s].label} <span className="text-muted-foreground">({(groups.get(s) ?? []).length})</span>
            </h2>
            <p className="text-xs text-muted-foreground">{stageLabels[s].help}</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {(groups.get(s) ?? []).map((i) => (
              <ReviewCard
                key={i.id}
                item={i}
                proposedAt={proposed.get(i.id) ?? null}
                images={i.media.map((m) => ({
                  label: m.label ?? m.kind,
                  src: m.bucket === BRAND_BUCKET
                    ? (m.storage_path ? signed.get(m.storage_path) ?? m.url ?? null : m.url)
                    : `/clients/${i.client_id}/creative/${m.asset_id}`,
                  width: m.width,
                  height: m.height,
                }))}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
