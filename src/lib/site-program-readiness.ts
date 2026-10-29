// Wording for site_program_readiness() (20261029200000): Gate B "Strategy
// Ready" and Gate C "Content Ready" per site program. Pure: it labels what
// the database decided and never decides anything itself. An unknown figure
// (null) is "NOT VERIFIED", never 0. Used by scripts/site-program-readiness.mjs.

export type GateStatus = "ready" | "limited" | "not_verified" | "blocked";
export type Reason = { code: string; severity: Exclude<GateStatus, "ready">; count?: number; detail?: string };
export type Gate = { status: GateStatus; reasons: Reason[] };
export type Warning = { code: string; count?: number; detail?: string };
type Counts = Record<string, number>;
type Purpose = { ok: number; problems: Counts };

export type ProgramReport = {
  program_id: string | null;
  name: string;
  site_url: string | null;
  list: { id: string; version: number; status: string; approved: boolean; approved_at: string | null; size: number } | null;
  newer_proposal: { id: string; version: number; status: string; size: number } | null;
  intents: Counts | null;
  owners: { post: Purpose; blog: Purpose; refresh: Purpose } | null;
  owner_pages: {
    urls: number; live: number; stale: number; unchecked: number; oldest_check: string | null;
    not_live: { url: string; verdict: string; checked_on: string }[];
    top_url: string | null; top_keywords: number | null; top_share: number | null;
  } | null;
  geography: (Counts & { assessed: boolean }) | null;
  markets: { recorded: number; approved: number };
  holds: { active: number; open_conflicts_client: number | null };
  brand: { approved: boolean; source: string };
  services_approved: number;
  claims: { scope: string; usable: number; confirmed: number; unverified: number; site_usable: number | null; newest_confirmed: string | null };
  proof: { scope: string; photos: number; own_work_approved: number; unreviewed: number; site_own_work_approved: number | null };
  authority: { last_run_at: string | null; age_days: number | null; predates_list_approval: boolean | null };
  onboarding: { client_level: Counts; site_level: Counts };
  problems: { keyword_id: string; keyword: string; owner: string | null; owner_detail: string | null; geography: string | null;
              places: { place: string; state: string; basis: string; market: boolean }[] | null; structured_city: string | null }[];
  gate_b: Gate;
  gate_c: Gate;
  warnings: Warning[];
};
export type ReadinessReport = {
  version: string;
  client_id: string;
  client: string;
  as_of: string;
  multi_brand: boolean;
  geography: { assessed: boolean; sources: { source: string; sha256: string; names: number; loaded_at: string }[] };
  programs: ProgramReport[];
};

export const NOT_VERIFIED = "NOT VERIFIED";

export const STATUS_LABEL: Record<GateStatus, string> = {
  ready: "READY",
  limited: "LIMITED",
  not_verified: NOT_VERIFIED,
  blocked: "BLOCKED",
};

// Every reason and warning code the migration can emit (owner:<code> uses
// the resolver's own message). tests/site-program-readiness.test.mjs checks
// this list against the migration.
export const REASON_TEXT: Record<string, string> = {
  program_site_missing: "The site program has no website URL.",
  list_missing: "No Core 50 list exists for this site.",
  list_not_approved: "The Core 50 list is a proposal; a teammate must approve it on the Keywords tab.",
  list_size: "The list does not hold exactly 50 distinct keywords.",
  keyword_missing: "List members no longer exist as this client's keywords.",
  keyword_inactive: "List members are inactive.",
  intent_missing: "List members have no search intent.",
  place_without_market: "Keywords name a place that is not an approved market of this site.",
  place_text_only: "Keywords name an approved market only in their text; record keywords.market_id.",
  place_mismatch: "Keywords name a different place from their recorded city or market.",
  geography_unassessed: "No place reference is loaded, so places named in keyword text are unchecked.",
  strategy_not_ready: "Gate B is not ready.",
  brand_not_approved: "The brand for this site is not approved.",
  services_missing: "The site has no approved service.",
  claims_missing: "No usable claim (confirmed, or sourced with its source).",
  claims_client_scope: "Claims carry no brand site, so none is verified for this site.",
  claims_thin: "Fewer than three usable claims.",
  proof_client_scope: "Assets carry no brand site, so no own-work proof is verified for this site.",
  proof_own_work_missing: "No reviewed own-work photo; draft only what needs no project proof, with accurately labelled assets.",
  proof_thin: "Fewer than six reviewed own-work photos.",
  intent_absent: "No keyword of this intent (a note, not a quota).",
  owner_concentration: "One page owns half the list or more (an audit note, not a call for more pages).",
  blog_supply_low: "Fewer than eight keywords can anchor a new blog post.",
  claims_no_review_date: "Claims record no expiry or review date yet (W1).",
  claims_unconfirmed: "No claim is client-confirmed.",
  hold_conflicts_open: "Existing content matches a held offering.",
  hold_conflicts_unreadable: "Open hold conflicts could not be read by this caller.",
  authority_never_run: "The Authority Engine has never run for this client.",
  authority_predates_list: "The latest Authority run predates this list's approval.",
};

// Codes whose database detail adds a fact (a version, a page, an intent);
// for the rest the sentence above already says it.
const SHOW_DETAIL = new Set(["list_not_approved", "intent_absent", "owner_concentration", "geography_unassessed"]);
const detailOf = (r: { code: string; detail?: string }) => (r.detail && SHOW_DETAIL.has(r.code) ? ` ${r.detail}` : "");

export function reasonText(code: string): string {
  if (code.startsWith("owner:")) return `Owner resolver: ${code.slice(6).replace(/_/g, " ")}.`;
  return REASON_TEXT[code] ?? code;
}

// A figure, or NOT VERIFIED when the database could not establish it.
export function fig(n: number | string | null | undefined): string {
  return n === null || n === undefined ? NOT_VERIFIED : String(n);
}

const share = (x: number | null) => (x === null ? NOT_VERIFIED : `${Math.round(x * 100)}%`);
const counts = (c: Counts | null | undefined) =>
  c && Object.keys(c).length ? Object.entries(c).map(([k, v]) => `${k} ${v}`).join(", ") : "none";

export function programLines(p: ProgramReport): string[] {
  const out: string[] = [];
  out.push(`${p.name}${p.site_url ? ` (${p.site_url})` : ""}`);
  out.push(`  Gate B ${STATUS_LABEL[p.gate_b.status]} · Gate C ${STATUS_LABEL[p.gate_c.status]}`);
  out.push(p.list
    ? `  Core 50: v${p.list.version} ${p.list.approved ? "approved" : p.list.status}, ${p.list.size} keywords` +
      (p.newer_proposal ? `; newer v${p.newer_proposal.version} ${p.newer_proposal.status} (${p.newer_proposal.size})` : "")
    : `  Core 50: ${NOT_VERIFIED} (no list)`);
  if (p.intents) out.push(`  Intents: I ${p.intents.informational} / C ${p.intents.commercial} / T ${p.intents.transactional} / N ${p.intents.navigational} / none ${p.intents.none}`);
  if (p.owners) out.push(`  Owners ok: post ${p.owners.post.ok}, blog ${p.owners.blog.ok}, refresh ${p.owners.refresh.ok}`);
  if (p.owner_pages) out.push(`  Owner pages: ${p.owner_pages.live}/${p.owner_pages.urls} live, ${p.owner_pages.stale} stale, ${p.owner_pages.unchecked} unchecked; top ${share(p.owner_pages.top_share)}${p.owner_pages.top_url ? ` on ${p.owner_pages.top_url}` : ""}`);
  if (p.geography) out.push(p.geography.assessed
    ? `  Places: structured ${p.geography.structured}, none ${p.geography.none}, text only ${p.geography.text_only}, without market ${p.geography.without_market}, mismatch ${p.geography.mismatch}`
    : `  Places: ${NOT_VERIFIED} (no place reference loaded; ${p.geography.unassessed} keywords unchecked)`);
  out.push(`  Markets: ${p.markets.approved} approved of ${p.markets.recorded}; holds active ${p.holds.active}, open conflicts ${fig(p.holds.open_conflicts_client)}`);
  out.push(`  Claims (${p.claims.scope}): usable ${p.claims.usable} (${p.claims.confirmed} confirmed), unverified ${p.claims.unverified}; this site ${fig(p.claims.site_usable)}`);
  out.push(`  Proof (${p.proof.scope}): own-work reviewed ${p.proof.own_work_approved} of ${p.proof.photos} photos; this site ${fig(p.proof.site_own_work_approved)}`);
  out.push(`  Authority: ${p.authority.last_run_at ? `last run ${p.authority.last_run_at.slice(0, 10)} (${p.authority.age_days} days)` : "never run"}`);
  out.push(`  Onboarding: client ${counts(p.onboarding.client_level)}; site ${counts(p.onboarding.site_level)}`);
  for (const g of [["B", p.gate_b], ["C", p.gate_c]] as const)
    for (const r of g[1].reasons) out.push(`  [${g[0]} ${STATUS_LABEL[r.severity]}] ${reasonText(r.code)}${r.count !== undefined ? ` (${r.count})` : ""}${detailOf(r)}`);
  for (const w of p.warnings) out.push(`  [note] ${reasonText(w.code)}${w.count !== undefined ? ` (${w.count})` : ""}${detailOf(w)}`);
  for (const k of p.problems) {
    const where = k.places?.map((x) => `${x.place}, ${x.state}${x.market ? " (market)" : ""}`).join("; ");
    out.push(`    - "${k.keyword}": ${[k.owner && `owner ${k.owner}`, k.geography && `place ${k.geography}${where ? ` [${where}]` : ""}`].filter(Boolean).join(", ")}`);
  }
  return out;
}

export function renderReadiness(r: ReadinessReport): string {
  const head = [
    `Site-program readiness — ${r.client} (${r.client_id})`,
    `As of ${r.as_of}; ${r.version}; place reference ${r.geography.assessed ? r.geography.sources.map((s) => `${s.source} ${s.sha256.slice(0, 12)}`).join(", ") : NOT_VERIFIED}`,
    "Gate C is evidence for safe drafting, never permission to publish.",
  ];
  return [...head, ...r.programs.flatMap((p) => ["", ...programLines(p)])].join("\n");
}
