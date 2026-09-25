import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  assessIntelligence,
  intentCounts,
  intentPostGuidance,
  pilotReadiness,
  SEARCH_INTENTS,
  topicCandidates,
  type AreaStatus,
  type IntelligenceInput,
} from "@/lib/client-intelligence";
import { cn } from "@/lib/utils";

const statusStyles: Record<AreaStatus, string> = {
  ready: "bg-green-100 text-green-800 border-green-200",
  partial: "bg-amber-100 text-amber-800 border-amber-200",
  missing: "bg-red-100 text-red-800 border-red-200",
};

// Where each area is fixed today.
const fixTab: Record<string, { label: string; segment: string } | null> = {
  facts: { label: "Overview", segment: "" },
  brand: { label: "Brand", segment: "brand" },
  services: { label: "Services", segment: "services" },
  audience: { label: "Brand", segment: "brand" },
  locations: { label: "Keywords", segment: "keywords" },
  offers: null,
  proof: { label: "Foundation", segment: "foundation" },
  assets: { label: "Brand", segment: "brand" },
  keywords: { label: "Keywords", segment: "keywords" },
  rules: { label: "Brand", segment: "brand" },
};

// Areas with no tab to fix them in yet.
const noFixTab: Record<string, string> = {
  offers: "Offers live in the CRM's offers table (exact terms, source, optional dates); there is no editing screen yet.",
};

export default async function IntelligencePage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await createClient();

  // The one read of Client Intelligence (migration 0047): the same function
  // the post-drafter Edge Function and the dry run call, so what this tab
  // reports is exactly what a draft may stand on.
  const { data, error } = await supabase.rpc("client_intelligence_input", { p_client_id: clientId });
  const input = data as unknown as IntelligenceInput | null;
  if (error || !input?.client) {
    return (
      <p role="alert" className="callout border-red-200 bg-red-50 text-red-900">
        Could not load this client&apos;s intelligence: {error?.message ?? "client not found"}.
      </p>
    );
  }

  const areas = assessIntelligence(input);
  const pilot = pilotReadiness(areas);
  const intents = intentCounts(input.keywords);
  const topics = topicCandidates(input);

  return (
    <div className="space-y-6">
      <section className="surface-tint space-y-3 p-4 sm:p-6">
        <p className="eyebrow">Client intelligence</p>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-bold tracking-tight">
            {pilot.ready} of {pilot.total} areas ready for AI-drafted posts
          </h2>
          <Badge
            variant="outline"
            className={pilot.isReady ? statusStyles.ready : statusStyles.partial}
          >
            {pilot.isReady ? "pilot-ready" : "not yet"}
          </Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          What an AI drafter may rely on when it writes a social or Business Profile post for this
          client. Every draft will have to cite facts from here and pass a person&apos;s review
          before anything is published. Posts support visibility and engagement; they are not a
          guarantee of Google rankings or topical authority.
        </p>
      </section>

      <section aria-label="Readiness by area" className="grid gap-4 md:grid-cols-2">
        {areas.map((a) => {
          const fix = fixTab[a.key];
          return (
            <Card key={a.key} size="sm">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <CardTitle>{a.label}</CardTitle>
                  <Badge variant="outline" className={cn("ml-auto", statusStyles[a.status])}>
                    {a.status}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">{a.summary}</p>
              </CardHeader>
              {(a.gaps.length > 0 || !a.blocking) && (
                <CardContent className="space-y-2 text-sm">
                  {a.gaps.length > 0 && (
                    <ul className="list-disc space-y-1 pl-5">
                      {a.gaps.map((g) => (
                        <li key={g}>{g}</li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {!a.blocking && "Does not block general posts; only content that needs it. "}
                    {fix ? (
                      <>
                        Fix on the{" "}
                        <Link
                          href={`/clients/${clientId}${fix.segment ? `/${fix.segment}` : ""}`}
                          className="font-medium text-royal-600 hover:underline"
                        >
                          {fix.label} tab
                        </Link>
                        .
                      </>
                    ) : (
                      noFixTab[a.key] ?? null
                    )}
                  </p>
                </CardContent>
              )}
            </Card>
          );
        })}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Search intent</CardTitle>
          <p className="text-sm text-muted-foreground">
            {intents.active} active keywords
            {intents.unlabelled ? ` · ${intents.unlabelled} without an intent` : ""}
            {intents.unlabelledWithNote ? ` (${intents.unlabelledWithNote} with a note)` : ""}
            {intents.nonStandard ? ` · ${intents.nonStandard} with a note instead of an intent` : ""}
          </p>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {SEARCH_INTENTS.map((i) => (
              <div key={i} className="rounded-xl bg-muted/70 p-3 ring-1 ring-border">
                <dt className="eyebrow">{intentPostGuidance[i].label}</dt>
                <dd className="mt-1 text-2xl font-bold tabular-nums">{intents.counts[i]}</dd>
                <dd className="mt-1 text-xs text-muted-foreground">{intentPostGuidance[i].use}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Post topics</CardTitle>
          <p className="text-sm text-muted-foreground">
            Approved services with keywords of a known intent. A post starts from one row: the
            service, its page and one intent.
          </p>
        </CardHeader>
        <CardContent>
          {topics.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No topics yet: approve services and link keywords with a labelled intent to them.
            </p>
          ) : (
            <ul className="divide-y text-sm">
              {topics.map((t) => (
                <li key={t.serviceId} className="space-y-1.5 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-semibold text-navy-900">{t.service}</span>
                    {t.pageUrl && <span className="text-xs text-muted-foreground break-all">{t.pageUrl}</span>}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {SEARCH_INTENTS.filter((i) => t.intents[i]).map((i) => (
                      <span
                        key={i}
                        className="rounded-full bg-royal-50 px-2 py-0.5 text-xs text-navy-700 ring-1 ring-royal-100"
                        title={intentPostGuidance[i].use}
                      >
                        <span className="font-semibold">{intentPostGuidance[i].label}:</span>{" "}
                        {t.intents[i]!.join(", ")}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
