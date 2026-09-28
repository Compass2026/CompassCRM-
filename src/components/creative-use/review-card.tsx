"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { reviewCreativeUseAction, type ReviewAnswer } from "@/app/creative-use-actions";
import {
  fileBlockers, fileStatus, fileStatusLabel, isPhoto, readSuggestions, useLabels,
  type CreativeUse, type ReviewAsset,
} from "@/lib/creative-use";
import { cn } from "@/lib/utils";

const pct = (v: number | null) => (v == null ? "" : String(Math.round(v * 1000) / 10));
const useBadge: Record<CreativeUse, string> = {
  unreviewed: "bg-muted text-muted-foreground",
  approved: "bg-green-100 text-green-800 border-green-200",
  excluded: "bg-red-50 text-red-800 border-red-200",
};

// One image's review. Governed values (left of the form) are what the
// database holds; AI suggestions are shown apart and only prefill fields when
// the teammate asks — they never decide own work and never submit.
export function ReviewCard({ clientId, asset, imageUrl, history }: {
  clientId: string;
  asset: ReviewAsset;
  imageUrl: string | null;
  history: { id: number; line: string; at: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const [message, setMessage] = useState<ReviewAnswer | null>(null);
  const use = (["approved", "excluded"].includes(asset.creative_use) ? asset.creative_use : "unreviewed") as CreativeUse;
  const [decision, setDecision] = useState<string>(use);
  const [ownWork, setOwnWork] = useState(asset.depicts_own_work === true ? "yes" : asset.depicts_own_work === false ? "no" : "");
  const [subjects, setSubjects] = useState(asset.subjects.join(", "));
  const [fx, setFx] = useState(pct(asset.focal_x));
  const [fy, setFy] = useState(pct(asset.focal_y));
  const [reason, setReason] = useState(asset.creative_review_note ?? "");
  const status = fileStatus(asset);
  const blockers = fileBlockers(asset);
  const photo = isPhoto(asset);
  const sugg = readSuggestions(asset.creative_suggestions);

  const pickFocal = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setFx(String(Math.round(((e.clientX - r.left) / r.width) * 1000) / 10));
    setFy(String(Math.round(((e.clientY - r.top) / r.height) * 1000) / 10));
  };
  const submit = () => {
    if (busy.current) return;
    busy.current = true;
    startTransition(async () => {
      const r = await reviewCreativeUseAction(clientId, asset.id,
        { content_hash: asset.content_hash, creative_use: asset.creative_use, creative_reviewed_at: asset.creative_reviewed_at },
        { decision, ownWork, subjects, focalX: fx, focalY: fy, reason });
      busy.current = false;
      setMessage(r);
      if (r.ok || (!r.ok && r.changed)) router.refresh();
    });
  };

  return (
    <li className="surface grid gap-4 p-4 md:grid-cols-[minmax(0,220px)_1fr]" data-asset={asset.id} data-use={use} data-file={status}>
      <div className="space-y-2">
        <div
          className={cn("relative aspect-square w-full overflow-hidden rounded-md border bg-white", imageUrl && "cursor-crosshair")}
          onClick={imageUrl ? pickFocal : undefined}
          data-focal-picker
          title={imageUrl ? "Click to set the focal point" : undefined}
        >
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imageUrl} alt={asset.label} className="size-full object-contain" />
          ) : (
            <span className="flex size-full items-center justify-center text-xs text-muted-foreground">No stored image</span>
          )}
          {fx !== "" && fy !== "" && (
            <span className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-red-600 shadow"
              style={{ left: `${fx}%`, top: `${fy}%` }} data-focal-marker />
          )}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
          <dt className="text-muted-foreground">Kind</dt><dd>{asset.kind}</dd>
          <dt className="text-muted-foreground">Source</dt><dd>{asset.source === "website_scan" ? "Website scan" : asset.source}</dd>
          <dt className="text-muted-foreground">Size</dt><dd data-dimensions>{asset.width && asset.height ? `${asset.width}×${asset.height}` : "unknown"}</dd>
          <dt className="text-muted-foreground">SHA-256</dt>
          <dd className="break-all" data-hash-status={status}>
            {status === "hashed" ? <span className="font-mono">{asset.content_hash!.slice(0, 16)}…</span> : fileStatusLabel[status]}
          </dd>
        </dl>
        {asset.url && <a className="block truncate text-xs underline underline-offset-2" href={asset.url} target="_blank" rel="noreferrer">Original link ↗</a>}
      </div>

      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 flex-1 break-words text-sm font-semibold">{asset.label}</h3>
          <Badge variant="outline" className={useBadge[use]} data-use-badge>{useLabels[use]}</Badge>
        </div>

        {/* Governed values, as stored */}
        <div className="grid gap-1 text-xs sm:grid-cols-2" data-governed>
          <div><span className="text-muted-foreground">Client&apos;s own work: </span>{asset.depicts_own_work == null ? "not decided" : asset.depicts_own_work ? "yes" : "no"}</div>
          <div><span className="text-muted-foreground">Subjects: </span>{asset.subjects.length ? asset.subjects.join(", ") : "none"}</div>
          <div><span className="text-muted-foreground">Focal point: </span>{asset.focal_x == null ? "not set" : `${pct(asset.focal_x)}%, ${pct(asset.focal_y)}%`}</div>
          {asset.creative_review_note && <div className="sm:col-span-2"><span className="text-muted-foreground">Note: </span>{asset.creative_review_note}</div>}
        </div>

        {sugg && (
          <div className="rounded-md border border-dashed bg-muted/40 p-2 text-xs" data-suggestions>
            <p className="font-medium">AI suggestions — not reviewed{sugg.model ? ` (${sugg.model})` : ""}</p>
            {sugg.subjects.length > 0 && <p>Subjects: {sugg.subjects.join(", ")}</p>}
            {sugg.focal && <p>Focal point: {pct(sugg.focal.x)}%, {pct(sugg.focal.y)}%</p>}
            {sugg.ownWork !== null && <p>Own work: {sugg.ownWork ? "suggested yes" : "suggested no"} — decide it yourself below.</p>}
            <div className="mt-1 flex flex-wrap gap-2">
              {sugg.subjects.length > 0 && <Button type="button" size="xs" variant="outline" data-use-suggested-subjects
                onClick={() => setSubjects(sugg.subjects.join(", "))}>Use suggested subjects</Button>}
              {sugg.focal && <Button type="button" size="xs" variant="outline" data-use-suggested-focal
                onClick={() => { setFx(pct(sugg.focal!.x)); setFy(pct(sugg.focal!.y)); }}>Use suggested focal point</Button>}
            </div>
          </div>
        )}

        {/* The decision */}
        <fieldset className="space-y-2 text-sm" disabled={pending}>
          <legend className="sr-only">Creative use decision</legend>
          <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Decision">
            {(["approved", "excluded", "unreviewed"] as const).map((d) => (
              <label key={d} className="flex items-center gap-1.5">
                <input type="radio" name={`decision-${asset.id}`} value={d} checked={decision === d} onChange={() => setDecision(d)} data-decision={d} />
                {d === "approved" ? "Approve for creative" : d === "excluded" ? "Exclude" : "Keep unreviewed"}
              </label>
            ))}
          </div>
          {photo && (
            <div className="flex flex-wrap items-center gap-3" role="radiogroup" aria-label="Client's own work">
              <span className="text-xs text-muted-foreground">Shows the client&apos;s own work?</span>
              {[["yes", "Yes"], ["no", "No"], ["", "Not decided"]].map(([v, l]) => (
                <label key={v || "undecided"} className="flex items-center gap-1.5 text-xs">
                  <input type="radio" name={`own-${asset.id}`} value={v} checked={ownWork === v} onChange={() => setOwnWork(v)} data-own-work={v || "undecided"} />
                  {l}
                </label>
              ))}
            </div>
          )}
          <label className="block text-xs">
            <span className="text-muted-foreground">Subject tags (comma-separated, lower case)</span>
            <input className="field mt-0.5 w-full" value={subjects} onChange={(e) => setSubjects(e.target.value)} placeholder="roof, shingles, finished project" data-subjects />
          </label>
          <div className="flex flex-wrap items-end gap-2 text-xs">
            <label><span className="text-muted-foreground">Focal x %</span>
              <input className="field mt-0.5 w-20" inputMode="decimal" value={fx} onChange={(e) => setFx(e.target.value)} data-focal-x /></label>
            <label><span className="text-muted-foreground">Focal y %</span>
              <input className="field mt-0.5 w-20" inputMode="decimal" value={fy} onChange={(e) => setFy(e.target.value)} data-focal-y /></label>
            <span className="pb-1 text-muted-foreground">{photo ? "Required for photos. " : ""}Click the image to set it.</span>
          </div>
          {(decision === "excluded" || reason) && (
            <label className="block text-xs">
              <span className="text-muted-foreground">Reason{decision === "excluded" ? " (required to exclude)" : ""}</span>
              <textarea className="field mt-0.5 w-full" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} data-reason />
            </label>
          )}
          {decision === "approved" && blockers.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-amber-900" data-blockers>{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          )}
          <Button type="button" size="sm" onClick={submit} disabled={pending} data-save-review>
            {pending ? "Saving…" : "Save decision"}
          </Button>
        </fieldset>
        {message && (
          <div role="status" data-review-message={message.ok ? "ok" : "refused"} className={cn("text-xs", message.ok ? "text-green-800" : "text-amber-900")}>
            <p>{message.text}</p>
            {!message.ok && message.errors && <ul className="list-disc pl-5">{message.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
          </div>
        )}

        <details className="text-xs" data-history>
          <summary className="cursor-pointer text-muted-foreground">Review history ({history.length})</summary>
          <ol className="mt-1 space-y-0.5">
            {history.length === 0 && <li className="text-muted-foreground">Nothing yet.</li>}
            {history.map((h) => <li key={h.id}><span className="text-muted-foreground">{h.at.slice(0, 16).replace("T", " ")} · </span>{h.line}</li>)}
          </ol>
        </details>
      </div>
    </li>
  );
}
