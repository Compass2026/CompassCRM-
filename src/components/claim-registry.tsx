import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BUCKET_HELP,
  BUCKET_LABEL,
  BUCKET_TONE,
  COUNT_TILES,
  SOURCE_CLASS_LABEL,
  STATUS_LABEL,
  affectedLinks,
  eligibilityLabels,
  fig,
  groupByBucket,
  reasonLines,
  reviewLine,
  verificationLine,
  type ClaimRegistry,
  type RegistryClaim,
  type RegistryProgram,
} from "@/lib/claim-registry";
import { cn } from "@/lib/utils";

const toneStyles = {
  ok: "bg-green-100 text-green-800 border-green-200",
  warn: "bg-amber-100 text-amber-800 border-amber-200",
  bad: "bg-red-100 text-red-800 border-red-200",
} as const;

// The Claims registry section of the Intelligence tab (20261103220000).
// Read-only: no button here changes a claim, a post or a draft.
export function ClaimRegistrySection({
  clientId,
  registry,
  error,
}: {
  clientId: string;
  registry: ClaimRegistry | null;
  error: string | null;
}) {
  return (
    <Card data-card="claim-registry">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>Claims registry</CardTitle>
          <Badge variant="outline" className="ml-auto">
            read-only
          </Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          What every claim stands on: its source, who verified it and when, when it is due for review, which brand
          site may use it, and which posts and drafts cite it. This view changes nothing. Posts and drafts still
          follow today&apos;s rule: a confirmed claim, or a sourced one with a source, and never an unverified one.
          &ldquo;Citable under current rules&rdquo; is that rule; &ldquo;independently verified&rdquo; needs a recorded
          method and evidence, which the verification workflow will add.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {error || !registry ? (
          <p role="alert" className="text-sm text-amber-900" data-registry-unavailable>
            The claims registry could not be read{error ? `: ${error}` : ""}.
          </p>
        ) : (
          <>
            <section aria-label="Claims by site" className="space-y-3">
              {registry.programs.map((p) => (
                <ProgramCounts key={p.workspace_id ?? "client"} program={p} />
              ))}
              {registry.multi_site && (
                <p className="text-xs text-muted-foreground" data-registry-unassigned>
                  Assigned to no brand site: {fig(registry.totals.unassigned)} of {registry.totals.total} claims.
                  Shared by more than one brand site: {fig(registry.totals.shared)}.
                </p>
              )}
              {registry.totals.cited_while_unusable > 0 && (
                <p role="status" className="text-sm font-medium text-red-800" data-registry-cited-unusable>
                  {registry.totals.cited_while_unusable} claim
                  {registry.totals.cited_while_unusable === 1 ? " is" : "s are"} cited by posts or drafts although
                  today&apos;s rules would refuse {registry.totals.cited_while_unusable === 1 ? "it" : "them"}
                  {registry.totals.published_while_unusable > 0
                    ? `, ${registry.totals.published_while_unusable} of them by published content`
                    : ""}
                  . Corrections go through the content team; nothing here changes the content.
                </p>
              )}
            </section>
            {registry.claims.length === 0 ? (
              <p className="text-sm text-muted-foreground">No claims recorded for this client yet.</p>
            ) : (
              groupByBucket(registry.claims).map((g) => (
                <details
                  key={g.bucket}
                  open={BUCKET_TONE[g.bucket] !== "ok"}
                  className="rounded-xl ring-1 ring-border"
                  data-bucket={g.bucket}
                >
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2">
                    <Badge variant="outline" className={toneStyles[BUCKET_TONE[g.bucket]]}>
                      {BUCKET_LABEL[g.bucket]}
                    </Badge>
                    <span className="text-sm font-semibold tabular-nums">{g.claims.length}</span>
                    <span className="text-xs text-muted-foreground">{BUCKET_HELP[g.bucket]}</span>
                  </summary>
                  <ul className="divide-y border-t">
                    {g.claims.map((c) => (
                      <ClaimRow key={c.id} clientId={clientId} claim={c} programs={registry.programs} />
                    ))}
                  </ul>
                </details>
              ))
            )}
            <p className="text-xs text-muted-foreground">
              Review intervals:{" "}
              {registry.intervals.map((i) => `${i.label.toLowerCase()} ${i.review_days} days`).join(" · ")}. A review
              is a prompt to re-check, not an expiry of the fact.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ProgramCounts({ program }: { program: RegistryProgram }) {
  return (
    <div className="space-y-1.5" data-program={program.slug ?? "client"}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-semibold text-navy-900">{program.name}</span>
        {program.website_url && <span className="text-xs break-all text-muted-foreground">{program.website_url}</span>}
        {program.scope === "brand_workspace" && !program.scope_authoritative && (
          <span className="text-xs text-amber-800">Brand workspace not approved: its scope is not counted.</span>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {COUNT_TILES.map((t) => {
          const n = program.counts ? program.counts[t.key] : null;
          return (
            <div
              key={t.key}
              className={cn(
                "rounded-lg px-2.5 py-1.5 ring-1",
                typeof n === "number" && n > 0 && t.tone !== "ok" ? toneStyles[t.tone] : "bg-muted/60 ring-border",
              )}
              data-count={t.key}
            >
              <dt className="text-[11px] tracking-wide uppercase">{t.label}</dt>
              <dd className="text-lg font-bold tabular-nums" title={n === null ? "Not assessed" : undefined}>
                {fig(n)}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function ClaimRow({
  clientId,
  claim: c,
  programs,
}: {
  clientId: string;
  claim: RegistryClaim;
  programs: RegistryProgram[];
}) {
  const links = affectedLinks(clientId, c);
  const eligibility = eligibilityLabels(c);
  const reasons = reasonLines(c);
  const siteName = (slug: string) => programs.find((p) => p.slug === slug)?.name ?? slug;
  return (
    <li className="space-y-1.5 px-3 py-3 text-sm" data-claim={c.id}>
      <div className="flex flex-wrap items-start gap-2">
        <span className="font-medium text-navy-900">{c.claim}</span>
        <Badge variant="outline" className="ml-auto">
          {STATUS_LABEL[c.status]}
        </Badge>
        <Badge variant="outline" className={toneStyles[c.legacy_usable ? "ok" : "bad"]} data-citable={c.legacy_usable}>
          {eligibility.citable}
        </Badge>
        <Badge
          variant="outline"
          className={c.verification_state === "independently_verified" ? toneStyles.ok : undefined}
          data-verification={c.verification_state}
        >
          {eligibility.verified}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground" data-source={c.source.class}>
        <span className="font-medium text-foreground">{SOURCE_CLASS_LABEL[c.source.class]}</span>
        {c.source.url ? (
          <>
            {" · "}
            <a href={c.source.url} target="_blank" rel="noreferrer" className="break-all text-royal-600 hover:underline">
              {c.source.host ?? c.source.url}
            </a>
          </>
        ) : c.source.text ? (
          ` · ${c.source.text}`
        ) : null}
      </p>
      <p className="text-xs text-muted-foreground">
        {verificationLine(c)} · {reviewLine(c)}
      </p>
      {(c.scope.programs.length > 0 || c.scope.unassigned) && (
        <p className="flex flex-wrap gap-1.5 text-xs">
          {c.scope.programs.map((s) => (
            <span key={s} className="rounded-full bg-royal-50 px-2 py-0.5 text-navy-700 ring-1 ring-royal-100">
              {siteName(s)}
            </span>
          ))}
          {c.scope.unassigned && <span className="text-amber-800">No brand site</span>}
        </p>
      )}
      {links.length > 0 && (
        <ul className="space-y-0.5 text-xs" aria-label="Cited by">
          {links.map((l) => (
            <li key={l.key} data-affected={l.published ? "published" : "unpublished"}>
              <Link href={l.href} className="font-medium text-royal-600 hover:underline">
                {l.label}
              </Link>{" "}
              <span className={l.published ? "font-medium text-navy-900" : "text-muted-foreground"}>({l.state})</span>
              {l.external && (
                <>
                  {" · "}
                  <a href={l.external} target="_blank" rel="noreferrer" className="text-royal-600 hover:underline">
                    live
                  </a>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {reasons.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-900" aria-label="Indicators">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </li>
  );
}
