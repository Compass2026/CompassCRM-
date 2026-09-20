// The website build brief — the durable record of what a build or upgrade
// is made from: the accepted foundation version and SHA, the client's
// repository and branches, the content adapter, the brand and factual
// sources, the page and keyword plan, the linking plan, the contact
// configuration, what is missing, and the evidence as it accumulates.
//
// Pure: composed from CRM rows the caller already loaded (the worker reads
// them with SQL; the app with Supabase). Stored on `sites.build_brief`,
// filed to Drive 04 Website as `Build Brief — <Client>` (a deliverables
// row), and attached to the Website stage's evidence. Nothing here invents a
// fact: unknown inputs land in `missing_inputs`, never in the plan.

import {
  FOUNDATION_V1_REPO,
  FOUNDATION_V1_SHA,
  describeAdapter,
  planMutation,
  type ContentAdapterKey,
  type ContentPaths,
} from "./content-adapters.ts";

export type WorkMode = "new_build" | "upgrade_existing" | "client_retains";

export interface FoundationRelease {
  version: string; // "v1"
  source_repo: string; // "Compass2026/showmeelectricalwebsite"
  source_sha: string;
  accepted_on: string | null;
  documents: { label: string; url: string }[];
  handoff_doc: string | null;
}

export const FOUNDATION_V1: FoundationRelease = {
  version: "v1",
  source_repo: FOUNDATION_V1_REPO,
  source_sha: FOUNDATION_V1_SHA,
  accepted_on: "2026-09-20",
  documents: [
    { label: "Compass Website Build Standard v1.1", url: "https://docs.google.com/document/d/1aN23Jc2rvN31doduv3leMimEj8pqo4xUThO2o7AlA9w/edit" },
    { label: "Compass Page Template Library v1.1", url: "https://docs.google.com/document/d/1CsSsey-3KO830-u3XPOY1L2AVOfX7XDrr7qFg_1st_8/edit" },
    { label: "Compass Website Foundation v1: Review and Completion Brief", url: "https://docs.google.com/document/d/1exdtCcFvmH0kn5pEPc9cjAJDhnv7WgqfOieO7NTnxcc/edit" },
  ],
  handoff_doc: "https://github.com/Compass2026/showmeelectricalwebsite/blob/codex/foundation-v1-handoff/docs/foundation-v1-handoff.md",
};

// ── Inputs (the CRM rows, already loaded) ─────────────────────────────────
export interface ClientRow {
  id: string;
  name: string;
  dba?: string | null;
  vertical: string | null;
  business_type: "storefront" | "service_area" | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  address_line1?: string | null;
  service_area: string | null;
  website_url: string | null;
  drive_folders?: Record<string, string> | null;
}

export interface SiteRow {
  id: string | null;
  url: string | null;
  stack: "astro" | "nextjs" | "other" | null;
  controlled_by_compass: boolean | null;
  repo_url: string | null;
  branch: string | null;
  preview_branch?: string | null;
  vercel_project: string | null;
  staging_url: string | null;
  domain_constant: string | null;
  work_mode: WorkMode | null;
  content_paths: ContentPaths | null;
  content_adapter?: ContentAdapterKey | null;
  foundation_version?: string | null;
  foundation_sha?: string | null;
}

export interface ServiceRow {
  id: string;
  name: string;
  segment: string | null;
  page_type: "service" | "hub";
  status: "proposed" | "approved" | "retired";
  page_url: string | null;
  parent_name?: string | null;
}

export interface PageGroupRow {
  id: string;
  name: string;
  page_type: "home" | "service" | "city" | "hub" | "other";
  target_url: string | null;
  city_tier: "1" | "2" | "fold" | null;
  status: "proposed" | "approved" | "retired";
  primary_keyword: string | null;
  primary_volume: number | null;
  supporting_keywords?: string[];
}

export interface ClaimRow {
  claim: string;
  status: "sourced" | "unverified" | "confirmed";
  source: string | null;
}

export interface LocationRow {
  name: string;
  city: string | null;
  state: string | null;
  is_physical_location: boolean | null;
  address_public?: boolean | null;
}

export interface BrandRow {
  tagline: string | null;
  positioning: string | null;
  standing_cta: string | null;
  hard_rules: string[];
  palette: { role: string; hex: string; source?: string }[];
  typography: { heading?: string; body?: string } | null;
  board_status: "draft" | "approved" | null;
  drive_doc_url: string | null;
}

export interface AssetRow {
  kind: string;
  label: string | null;
  url: string | null;
  width?: number | null;
  height?: number | null;
  is_primary?: boolean | null;
}

export interface CityEvidence {
  /** The client (or a sourced claim) confirms the city is served. */
  coverage_confirmed: boolean;
  /** Sourced, city-specific material (projects, constraints, customer questions) — the gate's second half. */
  distinctive_evidence: string[];
}

export interface BriefInput {
  client: ClientRow;
  site: SiteRow | null;
  release?: FoundationRelease;
  services: ServiceRow[];
  pageGroups: PageGroupRow[];
  claims: ClaimRow[];
  locations: LocationRow[];
  brand: BrandRow | null;
  assets: AssetRow[];
  /** Per city page-group name: what the gate has. Missing = nothing confirmed. */
  cityEvidence?: Record<string, CityEvidence>;
  /** From detectContentContract on the actual tree; null when the tree was not read. */
  detected?: { adapter: ContentAdapterKey; paths: ContentPaths; foundation?: { brand: string | null; version: "v1"; brands?: string[] }; reasons: string[]; missing_inputs?: string[]; writable?: boolean } | null;
  /** The repository's default branch as GitHub reports it, when known. */
  repoDefaultBranch?: string | null;
  generatedBy: string;
  now?: Date;
}

// ── Output ────────────────────────────────────────────────────────────────
export interface PagePlanEntry {
  group: string;
  type: PageGroupRow["page_type"];
  primary_keyword: string | null;
  volume: number | null;
  target_url: string | null;
  route: string | null;
  /** exists = a page serves it today; planned = to build in this batch; candidate = held by the city gate; proposed = needs a hand-built page (PR) */
  status: "exists" | "planned" | "candidate" | "proposed";
  reason: string;
}

export interface BuildBrief {
  brief_version: 1;
  generated_at: string;
  generated_by: string;
  client: { id: string; name: string; vertical: string | null; business_type: string | null };
  site_id: string | null;
  work_mode: WorkMode;
  standard: FoundationRelease & { applies_as: "source" | "reference" };
  repository: {
    url: string | null;
    baseline_branch: string;
    production_branch: string;
    preview_branch: string | null;
    pr_base: string;
    vercel_project: string | null;
    production_url: string | null;
  };
  framework: { stack: string; detected_from: string; foundation_adopted: boolean; foundation_version: string | null; foundation_sha: string | null };
  content_adapter: { key: ContentAdapterKey; label: string; paths: ContentPaths; mutations: Record<string, string>; detection: string[] };
  brand_sources: { label: string; url: string | null; status: string | null }[];
  factual_sources: { claim: string; status: string; source: string | null; usable: boolean }[];
  services: { name: string; segment: string | null; kind: "service" | "hub"; parent: string | null; page_url: string | null; status: string }[];
  coverage: {
    home: string | null;
    business_type: string | null;
    service_area: string | null;
    real_locations: { name: string; city: string | null; state: string | null; address_public: boolean | null }[];
    served_cities: { name: string; tier: string | null; gate: "planned" | "candidate"; coverage_confirmed: boolean; distinctive_evidence: string[] }[];
  };
  page_plan: PagePlanEntry[];
  internal_links: { from: string; to: string; reason: string }[];
  assets: { kind: string; label: string | null; url: string | null; size: string | null }[];
  contact: { phone: string | null; form: string; recipients: string; sender: string; analytics: string };
  missing_inputs: string[];
  evidence: {
    builder_checks: string[];
    independent_review: string[];
    deferred: string[];
    launch: string[];
  };
  preview: { url: string | null; deployment_url: string | null; pull_request_url: string | null; commit_url: string | null };
  acceptance_checks: string[];
}

function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function cityRoute(adapter: ContentAdapterKey, paths: ContentPaths, name: string, state: string | null): string | null {
  const r = describeAdapter(adapter, paths).routes.city;
  if (!r) return null;
  const [cityPart, statePart] = name.split(",").map((s) => s.trim());
  const st = (statePart ?? state ?? "").toLowerCase();
  const slug = slugify(cityPart) + (adapter === "foundation_brand_content" && st ? `-${st}` : "");
  return r.replace("{slug}", slug).replace("{city}", slugify(cityPart)).replace("{state}", st);
}

export function composeBuildBrief(input: BriefInput): BuildBrief {
  const now = input.now ?? new Date();
  const release = input.release ?? FOUNDATION_V1;
  const site = input.site;
  const missing: string[] = [];

  const workMode: WorkMode = site?.work_mode ?? (site && site.controlled_by_compass === false ? "client_retains" : site?.repo_url ? "upgrade_existing" : "new_build");
  if (!site?.work_mode) missing.push(`work_mode is not recorded on the site row (inferred ${workMode}); set it at intake or on the Foundation tab`);

  // Adapter: the detected tree wins; a recorded content_paths.adapter is next; a new build gets the Foundation.
  let adapterKey: ContentAdapterKey;
  let adapterPaths: ContentPaths;
  let detection: string[];
  if (input.detected) {
    adapterKey = input.detected.adapter;
    adapterPaths = input.detected.paths;
    detection = input.detected.reasons;
    for (const m of input.detected.missing_inputs ?? []) missing.push(`content contract: ${m}`);
    if (input.detected.writable === false && adapterKey !== "unsupported") missing.push("content contract is not writable until the inputs above are recorded; no push or pull request may be prepared");
  } else if (site?.content_paths?.adapter) {
    adapterKey = site.content_paths.adapter;
    adapterPaths = site.content_paths;
    detection = ["recorded on sites.content_paths (tree not read this run)"];
  } else if (workMode === "new_build") {
    adapterKey = "foundation_brand_content";
    adapterPaths = { adapter: "foundation_brand_content", brand: slugify(input.client.name), content_dir: `brands/${slugify(input.client.name)}/content`, blog_format: "typescript", city_route: "/service-area/{slug}", blog_route: "/blog/{slug}" };
    detection = [`new build from ${release.source_repo}@${release.source_sha.slice(0, 7)}: the Foundation brand-content adapter`];
  } else if (site?.content_paths?.locations) {
    adapterKey = site.content_paths.blog_format === "markdown" ? "markdown_blog" : "lucas_json";
    adapterPaths = site.content_paths;
    detection = ["recorded legacy content_paths (no adapter key); tree not read"];
  } else {
    adapterKey = "unsupported";
    adapterPaths = { adapter: "unsupported" };
    detection = ["no adapter recorded and the tree was not read: proposed documents until the repository is inspected"];
    if (workMode !== "client_retains") missing.push("repository tree not inspected: run site-push {read: true} and detectContentContract before any content change");
  }
  const adapter = describeAdapter(adapterKey, adapterPaths);

  const foundationAdopted = adapterKey === "foundation_brand_content" && (!!input.detected?.foundation?.brand || (workMode === "new_build" && !input.detected));
  const stack = site?.stack ?? (workMode === "new_build" ? "nextjs" : "other");
  const detectedFrom = input.detected ? "repository tree" : site?.stack ? "sites.stack" : workMode === "new_build" ? "the Foundation source" : "unknown";
  if (!input.detected && workMode === "upgrade_existing") missing.push("framework and adapter are from the site row, not from an inspected tree; confirm before the first change");

  const productionBranch = site?.branch ?? input.repoDefaultBranch ?? "main";
  if (!site?.branch && workMode !== "new_build") missing.push(`production branch not recorded on the site row (assuming ${productionBranch})`);
  const previewBranch = site?.preview_branch ?? (workMode === "client_retains" ? null : `compass/preview-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${slugify(input.client.name).slice(0, 24)}`);

  // Brand
  const brand = input.brand;
  const brandSources: BuildBrief["brand_sources"] = [];
  if (brand) {
    brandSources.push({ label: `Brand board (${brand.board_status ?? "no status"})`, url: brand.drive_doc_url, status: brand.board_status });
    if (brand.board_status !== "approved") missing.push("brand board is not approved; identity values are drafts until Tom approves it");
    if (!brand.palette.length) missing.push("no palette on the brand board");
    if (!brand.typography?.heading && !brand.typography?.body) missing.push("no typography on the brand board");
  } else {
    missing.push("no brand board");
  }
  const logo = input.assets.find((a) => a.kind === "logo_primary");
  if (!logo) missing.push("no primary logo asset");
  const photos = input.assets.filter((a) => a.kind === "photo");
  if (photos.length < 6) missing.push(`${photos.length} photo assets (the brand build asks for six); the rest stay labelled placeholders`);

  // Facts
  const factual = input.claims.map((c) => ({ claim: c.claim, status: c.status, source: c.source, usable: c.status !== "unverified" && !!c.source }));
  if (!factual.some((f) => f.usable)) missing.push("no sourced claims: no facts may appear beyond the business record");

  // Services
  const services = input.services
    .filter((s) => s.status !== "retired")
    .map((s) => ({ name: s.name, segment: s.segment, kind: s.page_type, parent: s.parent_name ?? null, page_url: s.page_url, status: s.status }));
  if (!services.length) missing.push("no services in the taxonomy");
  if (services.some((s) => s.status !== "approved")) missing.push("some services are still proposed");

  // Coverage and the city gate
  const realLocations = input.locations.filter((l) => l.is_physical_location).map((l) => ({ name: l.name, city: l.city, state: l.state, address_public: l.address_public ?? null }));
  const cityGroups = input.pageGroups.filter((g) => g.page_type === "city" && g.status !== "retired");
  const servedCities = cityGroups.map((g) => {
    const ev = input.cityEvidence?.[g.name] ?? { coverage_confirmed: false, distinctive_evidence: [] };
    const gate: "planned" | "candidate" = ev.coverage_confirmed && ev.distinctive_evidence.length > 0 ? "planned" : "candidate";
    return { name: g.name, tier: g.city_tier, gate, coverage_confirmed: ev.coverage_confirmed, distinctive_evidence: ev.distinctive_evidence };
  });
  for (const c of servedCities) {
    if (c.gate === "candidate") missing.push(`city ${c.name}: ${!c.coverage_confirmed ? "coverage not confirmed" : "no distinctive local material"} — stays a candidate, not a page`);
  }

  // Page plan
  const pagePlan: PagePlanEntry[] = input.pageGroups
    .filter((g) => g.status !== "retired")
    .map((g) => {
      const route = g.page_type === "city" ? cityRoute(adapterKey, adapterPaths, g.name, input.client.state) : null;
      if (g.target_url) return { group: g.name, type: g.page_type, primary_keyword: g.primary_keyword, volume: g.primary_volume, target_url: g.target_url, route, status: "exists" as const, reason: "a page serves this group today" };
      if (g.page_type === "city") {
        const c = servedCities.find((s) => s.name === g.name);
        return c?.gate === "planned"
          ? { group: g.name, type: g.page_type, primary_keyword: g.primary_keyword, volume: g.primary_volume, target_url: null, route, status: "planned" as const, reason: "coverage confirmed and distinctive local material recorded" }
          : { group: g.name, type: g.page_type, primary_keyword: g.primary_keyword, volume: g.primary_volume, target_url: null, route, status: "candidate" as const, reason: "city gate not passed" };
      }
      const m = planMutation(adapterKey, "service_page", adapterPaths);
      return { group: g.name, type: g.page_type, primary_keyword: g.primary_keyword, volume: g.primary_volume, target_url: null, route, status: m.mode === "proposed_document" ? ("proposed" as const) : ("planned" as const), reason: m.reason };
    });
  if (!pagePlan.length) missing.push("no page groups: keyword research has not produced a page plan");

  // Internal links — the contract from the Build Standard §6, only between planned/existing pages.
  const built = pagePlan.filter((p) => p.status === "exists" || p.status === "planned");
  const hubs = built.filter((p) => p.type === "hub");
  const links: BuildBrief["internal_links"] = [];
  for (const p of built) {
    if (p.type === "service" || p.type === "hub") links.push({ from: "home", to: p.group, reason: "homepage → priority service hubs and useful detail pages" });
    if (p.type === "city") {
      links.push({ from: "service-area hub", to: p.group, reason: "service-area hub → published city pages only" });
      for (const s of built.filter((b) => b.type === "service")) links.push({ from: p.group, to: s.group, reason: "city page → services actually offered there" });
    }
    if (p.type === "service") for (const h of hubs) links.push({ from: h.group, to: p.group, reason: "hub → implemented child services" });
  }

  const evidence: BuildBrief["evidence"] = {
    builder_checks: [],
    independent_review: [],
    deferred: [],
    launch: ["client approval", "DNS cutover", "redirects verified on the production host", "sitemap submitted", "field Core Web Vitals when available"],
  };

  const acceptance = workMode === "client_retains"
    ? ["proposed documents filed in 04 Website with a change_log row each", "no push, no deployment"]
    : [
        `preview branch created from ${productionBranch}; pull request base ${productionBranch}; ${productionBranch} unchanged until Tom merges`,
        "typecheck, build and manifest pass on the preview",
        "crawl passes on the preview with the production host remapped (one canonical, sitemap = manifest, no orphans, 404 on unknown paths)",
        "mocked provider form checks pass (nothing sent)",
        "browser checks on representative pages (no-JS, reduced motion, 390px, keyboard) or an honest 'deferred: no browser in this environment'",
        "no fictional or previous-client facts, recipients, images or redirects in the output",
        "preview link, commit and evidence attached to the Website stage and this brief",
      ];

  return {
    brief_version: 1,
    generated_at: now.toISOString(),
    generated_by: input.generatedBy,
    client: { id: input.client.id, name: input.client.name, vertical: input.client.vertical, business_type: input.client.business_type },
    site_id: site?.id ?? null,
    work_mode: workMode,
    standard: { ...release, applies_as: workMode === "new_build" ? "source" : "reference" },
    repository: {
      url: site?.repo_url ?? null,
      baseline_branch: productionBranch,
      production_branch: productionBranch,
      preview_branch: previewBranch,
      pr_base: productionBranch,
      vercel_project: site?.vercel_project ?? null,
      production_url: site?.url ?? input.client.website_url,
    },
    framework: {
      stack,
      detected_from: detectedFrom,
      foundation_adopted: foundationAdopted,
      foundation_version: foundationAdopted ? release.version : site?.foundation_version ?? null,
      foundation_sha: foundationAdopted ? release.source_sha : site?.foundation_sha ?? null,
    },
    content_adapter: {
      key: adapterKey,
      label: adapter.label,
      paths: adapterPaths,
      mutations: Object.fromEntries((["city_page", "blog_post", "service_page", "faq_addition"] as const).map((k) => [k, planMutation(adapterKey, k, adapterPaths).mode])),
      detection,
    },
    brand_sources: brandSources,
    factual_sources: factual,
    services,
    coverage: {
      home: input.client.city && input.client.state ? `${input.client.city}, ${input.client.state}` : null,
      business_type: input.client.business_type,
      service_area: input.client.service_area,
      real_locations: realLocations,
      served_cities: servedCities,
    },
    page_plan: pagePlan,
    internal_links: links,
    assets: input.assets.map((a) => ({ kind: a.kind, label: a.label, url: a.url, size: a.width && a.height ? `${a.width}×${a.height}` : null })),
    contact: {
      phone: input.client.phone,
      form: workMode === "new_build" ? "Foundation inquiry form (server validation, provider idempotency key, mocked in preview)" : "the site's existing form — preserve it",
      recipients: "server-side inquiry.config / environment only; never in the brief",
      sender: "verified sending domain in the deployment environment; never in the brief",
      analytics: "deferred unless the client record says otherwise",
    },
    missing_inputs: missing,
    evidence,
    preview: { url: site?.staging_url ?? null, deployment_url: null, pull_request_url: null, commit_url: null },
    acceptance_checks: acceptance,
  };
}

/** The Drive document body (Markdown; Drive converts it to a Google Doc). */
export function renderBuildBriefMarkdown(b: BuildBrief): string {
  const L: string[] = [];
  const h = (s: string) => L.push("", `## ${s}`, "");
  L.push(`# Build Brief — ${b.client.name}`, "", `Generated ${b.generated_at.slice(0, 10)} by ${b.generated_by}. Work mode: **${b.work_mode}**.`, "");
  L.push(`Standard: ${b.standard.version} at \`${b.standard.source_sha}\` in ${b.standard.source_repo} (${b.standard.applies_as}${b.standard.accepted_on ? `, accepted ${b.standard.accepted_on}` : ""}).`);
  for (const d of b.standard.documents) L.push(`- ${d.label}: ${d.url}`);
  h("Repository and branches");
  L.push(`- Repository: ${b.repository.url ?? "none yet"}`);
  L.push(`- Production branch of record: \`${b.repository.production_branch}\` (unchanged by preview work)`);
  L.push(`- Preview branch: \`${b.repository.preview_branch ?? "n/a"}\` · pull request base: \`${b.repository.pr_base}\``);
  L.push(`- Vercel project: ${b.repository.vercel_project ?? "none"} · production URL: ${b.repository.production_url ?? "none"}`);
  h("Framework and content adapter");
  L.push(`- Stack: ${b.framework.stack} (from ${b.framework.detected_from}); Foundation adopted: ${b.framework.foundation_adopted ? `yes (${b.framework.foundation_version} @ ${b.framework.foundation_sha?.slice(0, 7)})` : "no"}`);
  L.push(`- Adapter: ${b.content_adapter.label} — ${b.content_adapter.detection.join("; ")}`);
  L.push("- How changes reach the site: " + Object.entries(b.content_adapter.mutations).map(([k, v]) => `${k} → ${v}`).join(", "));
  h("Brand sources");
  for (const s of b.brand_sources) L.push(`- ${s.label}${s.url ? `: ${s.url}` : ""}`);
  h("Factual sources");
  for (const f of b.factual_sources) L.push(`- [${f.usable ? "usable" : "not usable"}] ${f.claim} (${f.status}${f.source ? `, ${f.source}` : ""})`);
  h("Services");
  for (const s of b.services) L.push(`- ${s.kind === "hub" ? "Hub: " : ""}${s.name}${s.parent ? ` (under ${s.parent})` : ""} — ${s.status}${s.page_url ? ` — ${s.page_url}` : ""}`);
  h("Coverage");
  L.push(`- Home: ${b.coverage.home ?? "unknown"} · type: ${b.coverage.business_type ?? "unknown"}`);
  L.push(`- Service area: ${b.coverage.service_area ?? "unknown"}`);
  L.push(`- Real locations: ${b.coverage.real_locations.length ? b.coverage.real_locations.map((l) => `${l.name} (${l.city ?? "?"}, ${l.state ?? "?"})`).join("; ") : "none recorded"}`);
  for (const c of b.coverage.served_cities) L.push(`- Served city ${c.name} (tier ${c.tier ?? "?"}): ${c.gate}${c.gate === "candidate" ? " — coverage " + (c.coverage_confirmed ? "confirmed" : "not confirmed") + ", local material " + (c.distinctive_evidence.length ? "recorded" : "none") : ""}`);
  h("Page and keyword plan");
  L.push("| Group | Type | Primary keyword | Volume | Status | Route / URL |", "|---|---|---|---|---|---|");
  for (const p of b.page_plan) L.push(`| ${p.group} | ${p.type} | ${p.primary_keyword ?? ""} | ${p.volume ?? ""} | ${p.status} | ${p.target_url ?? p.route ?? ""} |`);
  h("Internal links (planned)");
  for (const l of b.internal_links.slice(0, 60)) L.push(`- ${l.from} → ${l.to}: ${l.reason}`);
  if (b.internal_links.length > 60) L.push(`- … ${b.internal_links.length - 60} more`);
  h("Assets");
  for (const a of b.assets) L.push(`- ${a.kind}: ${a.label ?? ""}${a.size ? ` (${a.size})` : ""}${a.url ? ` ${a.url}` : ""}`);
  h("Contact configuration");
  L.push(`- Phone: ${b.contact.phone ?? "unknown"}`, `- Form: ${b.contact.form}`, `- Recipients: ${b.contact.recipients}`, `- Sender: ${b.contact.sender}`, `- Analytics: ${b.contact.analytics}`);
  h("Missing inputs");
  L.push(...(b.missing_inputs.length ? b.missing_inputs.map((m) => `- ${m}`) : ["- none"]));
  h("Acceptance checks");
  L.push(...b.acceptance_checks.map((c) => `- [ ] ${c}`));
  h("Evidence");
  L.push(`- Builder checks: ${b.evidence.builder_checks.join("; ") || "none yet"}`);
  L.push(`- Independent review: ${b.evidence.independent_review.join("; ") || "none yet"}`);
  L.push(`- Deferred: ${b.evidence.deferred.join("; ") || "none"}`);
  L.push(`- Launch work (separate): ${b.evidence.launch.join("; ")}`);
  h("Preview");
  L.push(`- URL: ${b.preview.url ?? "none"} · deployment: ${b.preview.deployment_url ?? "none"} · PR: ${b.preview.pull_request_url ?? "none"} · commit: ${b.preview.commit_url ?? "none"}`);
  return L.join("\n") + "\n";
}

// ── Attaching outcomes to the existing work records ───────────────────────
export interface PreviewOutcome {
  branch: string;
  base: string;
  commit_url: string | null;
  pull_request_url: string | null;
  deployment_url: string | null;
  checks: { name: string; result: "pass" | "fail" | "deferred" | "not_verified"; detail?: string }[];
}

export interface AttachedRecords {
  brief: BuildBrief;
  /** A line for client_stages.evidence. */
  evidence_line: string;
  /** Rows for `deliverables` (label, url, type). */
  deliverables: { label: string; url: string; type: "site" | "drive" }[];
  /** One `change_log` row. */
  change_log: { change_type: string; object_type: string; before: unknown; after: Record<string, unknown>; reasoning: string; status: "proposed" | "approved" };
  /** One `decisions` row when the branch of record was left alone (it always is for a preview). */
  decision: { playbook_step: string; decision: string; rule_text: string } | null;
}

/** Fold a preview result into the brief and produce the rows that attach it to the client's work records. */
export function attachPreviewOutcome(brief: BuildBrief, outcome: PreviewOutcome, today = new Date()): AttachedRecords {
  const pass = outcome.checks.filter((c) => c.result === "pass").map((c) => c.name);
  const fail = outcome.checks.filter((c) => c.result === "fail").map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  const deferred = outcome.checks.filter((c) => c.result === "deferred" || c.result === "not_verified").map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  const next: BuildBrief = {
    ...brief,
    repository: { ...brief.repository, preview_branch: outcome.branch, pr_base: outcome.base },
    evidence: { ...brief.evidence, builder_checks: [...brief.evidence.builder_checks, ...pass.map((p) => `pass: ${p}`), ...fail.map((f) => `fail: ${f}`)], deferred: [...brief.evidence.deferred, ...deferred] },
    preview: { url: outcome.deployment_url, deployment_url: outcome.deployment_url, pull_request_url: outcome.pull_request_url, commit_url: outcome.commit_url },
  };
  const date = today.toISOString().slice(0, 10);
  const evidenceLine = `worker: ${date} — preview ${outcome.branch} from ${outcome.base} (${outcome.base} unchanged); ${pass.length} checks pass, ${fail.length} fail, ${deferred.length} deferred; PR ${outcome.pull_request_url ?? "none"}; preview ${outcome.deployment_url ?? "none"}; commit ${outcome.commit_url ?? "none"}`;
  const deliverables: AttachedRecords["deliverables"] = [];
  if (outcome.deployment_url) deliverables.push({ label: `Preview — ${outcome.branch}`, url: outcome.deployment_url, type: "site" });
  if (outcome.pull_request_url) deliverables.push({ label: `Pull request — ${outcome.branch}`, url: outcome.pull_request_url, type: "site" });
  return {
    brief: next,
    evidence_line: evidenceLine,
    deliverables,
    change_log: {
      change_type: "preview_pushed",
      object_type: "site",
      before: { production_branch: outcome.base },
      after: { production_branch: outcome.base, preview_branch: outcome.branch, pull_request_url: outcome.pull_request_url, deployment_url: outcome.deployment_url, commit: outcome.commit_url, checks: outcome.checks },
      reasoning: `Preview work on ${outcome.branch}; the production branch of record ${outcome.base} was not moved. Builder-reported checks; independent review pending.`,
      status: "proposed",
    },
    decision: {
      playbook_step: "PB4b.preview",
      decision: "preview_from_branch_of_record",
      rule_text: `Preview branches are created from and pull requests target the site's recorded production branch (${outcome.base}); site-push never relabels the branch of record for a preview.`,
    },
  };
}
