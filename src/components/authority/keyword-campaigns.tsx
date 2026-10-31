import type { KeywordCampaign } from "../../../supabase/functions/authority/campaigns";

const labels = { website: "Website", blog: "Blog", google_business: "Business Profile", facebook: "Facebook", email: "Email", ads: "Paid ads" };
const statuses = { review_plan: "Review opportunities", existing_content: "Content recorded", not_planned: "Not planned", blocked: "Foundation blocked" };
type Channel = KeywordCampaign["channels"][number];
// A channel whose opportunities exist but cannot proceed says why (Core 50 or gate codes).
const statusOf = (c: Channel) => c.status === "blocked" && c.blocked_by?.length
  ? `Blocked: ${Array.from(new Set(c.blocked_by.map((b) => b.reason.replace(/_/g, " ")))).join(", ")}`
  : `${statuses[c.status]}${c.opportunity_keys.length > 0 ? ` (${c.opportunity_keys.length})` : ""}`;

export function KeywordCampaigns({ campaigns }: { campaigns: KeywordCampaign[] }) {
  if (!campaigns.length) return null;
  return (
    <section aria-labelledby="keyword-campaigns-heading" className="space-y-3">
      <div>
        <h2 id="keyword-campaigns-heading" className="text-lg font-semibold">Keyword campaigns</h2>
        <p className="text-sm text-muted-foreground">A planning snapshot from this analysis. Drafting still checks current evidence, brand rules and channel requirements. Publication requires human approval.</p>
      </div>
      {campaigns.map((campaign) => (
        <details key={campaign.key} className="rounded-lg border bg-card p-4">
          <summary className="cursor-pointer font-medium">
            {campaign.name}: {campaign.primary?.keyword ?? "Primary keyword needed"}
            <span className="ml-2 text-sm font-normal text-muted-foreground">{campaign.cluster.length} keywords{campaign.blockers.length ? " · Foundation blocked" : ""}</span>
          </summary>
          <div className="mt-4 space-y-4 text-sm">
            <dl className="grid gap-3 sm:grid-cols-2">
              <div><dt className="font-medium">Primary keyword</dt><dd>{campaign.primary?.keyword ?? (campaign.primary_excluded ? `Not usable: ${campaign.primary_excluded.keyword} (${campaign.primary_excluded.reason.replace(/_/g, " ")})` : "Not set")}</dd></div>
              <div><dt className="font-medium">Intent mix</dt><dd>{campaign.intent_mix.join(", ") || "Not validated"}</dd></div>
              <div><dt className="font-medium">Owner target page</dt><dd className="break-all">{campaign.owner_url ? <a className="underline" href={campaign.owner_url} target="_blank" rel="noreferrer">{campaign.owner_url}</a> : "Not set"}</dd></div>
              <div><dt className="font-medium">Authority objective</dt><dd>{campaign.objective}</dd></div>
            </dl>
            {campaign.blockers.length > 0 && <ul className="list-disc space-y-1 rounded-md bg-amber-50 p-4 pl-8 text-amber-950">{campaign.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
            <div><h3 className="font-medium">Supporting keyword cluster</h3><p>{campaign.cluster.filter((k) => k.id !== campaign.primary?.id).map((k) => `${k.keyword} (${k.intent ?? "unlabelled"})`).join("; ") || "No supporting keywords mapped."}</p></div>
            <div className="overflow-x-auto"><table className="w-full text-left">
              <caption className="sr-only">Channel plan for {campaign.name}</caption>
              <thead><tr className="border-b"><th scope="col" className="py-2 pr-3">Channel</th><th scope="col" className="pr-3">Purpose</th><th scope="col" className="pr-3">Status</th><th scope="col">Recorded</th></tr></thead>
              <tbody>{campaign.channels.map((c) => <tr key={c.channel} className="border-b last:border-0"><th scope="row" className="py-2 pr-3 font-medium">{labels[c.channel]}</th><td className="pr-3">{c.objective}</td><td className="pr-3">{statusOf(c)}</td><td>{c.existing}</td></tr>)}</tbody>
            </table></div>
            <div>
              <h3 className="font-medium">Measurement</h3>
              <p>Search Console: {campaign.measurement.window ?? "No observation window"} ({campaign.measurement.coverage} coverage). Impressions: {campaign.measurement.impressions ?? "Unknown"}; clicks: {campaign.measurement.clicks ?? "Unknown"}. Recorded content: {campaign.measurement.content_count}.</p>
              <p>Traffic and conversions: not connected to this campaign.</p>
              {campaign.measurement.ranks.length > 0 && <p>Latest tracked ranks: {campaign.measurement.ranks.map((r) => `${r.keyword}: ${r.type} ${r.position ?? "not found"} (${r.recorded_at.slice(0, 10)})`).join("; ")}</p>}
            </div>
            <p>Relevant evidence: {campaign.evidence_claim_ids.length} sourced or confirmed claims. Each draft must select claims relevant to its own angle.</p>
            {campaign.excluded.length > 0 && <details><summary className="cursor-pointer">Excluded keyword rows ({campaign.excluded.length})</summary><ul className="mt-2 list-disc pl-5">{campaign.excluded.map((k, index) => <li key={`${k.keyword}:${index}`}>{k.keyword}: {k.reason.replaceAll("_", " ")}</li>)}</ul></details>}
          </div>
        </details>
      ))}
    </section>
  );
}
