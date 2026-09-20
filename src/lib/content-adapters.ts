// Content adapters — how the Website Updates stage and the weekly blog may
// write into a client's site, per site shape. Pure: no Next, no Supabase,
// no `@/` alias, so `node --test` and the worker's CLI can import it.
//
// The rule the review asked for: a site's shape is detected from its actual
// repository tree, never inferred from another client's site and never
// assumed from a template version ("a template version is not evidence that
// an older site has already adopted it"). Each adapter says, per kind of
// change, whether the CRM may push it to the branch of record, must open a
// pull request against it, or must file a proposed document instead.

export type ContentAdapterKey =
  | "foundation_brand_content" // Compass Website Foundation v1: typed TS content under brands/<brand>/content
  | "lucas_json" // the Sept 14 contract: data/locations.json + data/blog-posts.json + /service-areas/[city]
  | "markdown_blog" // Next.js with a Markdown/MDX blog dir and JSON data files (BHG shape)
  | "unsupported";

export type ChangeKind = "city_page" | "blog_post" | "service_page" | "faq_addition";
export type MutationMode = "push" | "pull_request" | "proposed_document";

export interface ContentPaths {
  adapter?: ContentAdapterKey;
  brand?: string;
  locations?: string;
  blog?: string;
  blog_format?: "json" | "markdown" | "typescript";
  blog_dir?: string;
  city_route?: string;
  blog_route?: string;
  services_dir?: string;
  content_dir?: string;
  verify?: string[];
}

export interface AdapterDescription {
  key: ContentAdapterKey;
  label: string;
  /** Where each kind of change is written. Null = the adapter cannot express it. */
  writes: Partial<Record<ChangeKind, string>>;
  /** How each kind of change reaches the site. */
  mutation: Record<ChangeKind, MutationMode>;
  /** Path prefixes the CRM may write under. Anything else is refused. */
  allowedPaths: string[];
  /** What must pass before a push or a PR is opened. */
  verify: string[];
  /** Route templates, for keyword → page mapping. */
  routes: { city?: string; blog?: string; service?: string; location?: string };
  notes: string[];
}

export const FOUNDATION_V1_SHA = "94014af35316c94616dadb3f8d606a4b68577fb0";
export const FOUNDATION_V1_REPO = "Compass2026/showmeelectricalwebsite";

const DOC_ONLY: Record<ChangeKind, MutationMode> = {
  city_page: "proposed_document",
  blog_post: "proposed_document",
  service_page: "proposed_document",
  faq_addition: "proposed_document",
};

export function describeAdapter(key: ContentAdapterKey, paths: ContentPaths = {}): AdapterDescription {
  switch (key) {
    case "foundation_brand_content": {
      const brand = paths.brand ?? "<brand>";
      const dir = paths.content_dir ?? `brands/${brand}/content`;
      // Layout of the accepted foundation (94014af): brands/<brand>/content/
      // {blog,cities,services,legal}/ with an index.ts registry in each —
      // verified against the tree fixture in tests/content-adapters.test.mjs.
      return {
        key,
        label: "Compass Website Foundation v1 (typed brand content)",
        writes: {
          city_page: `${dir}/cities/<slug>.ts + registry entry in ${dir}/cities/index.ts`,
          blog_post: `${dir}/blog/<slug>.ts + registry entry in ${dir}/blog/index.ts`,
          service_page: `${dir}/services/<slug>.ts + registry entry in ${dir}/services/index.ts`,
          faq_addition: "the page's typed content file",
        },
        // Typed TypeScript content is compiled: nothing reaches the branch of
        // record without a build, the crawl and the manifest passing, so every
        // change is a pull request with that evidence — never a data push.
        mutation: { city_page: "pull_request", blog_post: "pull_request", service_page: "pull_request", faq_addition: "pull_request" },
        allowedPaths: [`${dir}/`, "docs/page-plan.md", "docs/route-manifest.md"],
        verify: ["npm run typecheck", `COMPASS_BRAND=${brand} npx next build`, `COMPASS_BRAND=${brand} npm run qa:manifest`, "npm run qa:crawl -- <preview> --host <production host> --assets remap"],
        routes: { city: "/service-area/{slug}", blog: "/blog/{slug}", service: "/services/{hub}/{slug}", location: "/locations/{slug}" },
        notes: [
          "Served-city pages live at /service-area/[city]; physical locations are a separate registry at /locations/[slug]. Never write a city into the locations registry.",
          "Content files are TypeScript, not JSON: an entry is a typed object plus a registry import. The city gate (coverage confirmed + distinctive local material) applies before a city page is registered.",
        ],
      };
    }
    case "lucas_json":
      return {
        key,
        label: "Sept 14 content contract (JSON data files)",
        writes: {
          city_page: paths.locations ?? "data/locations.json",
          blog_post: paths.blog ?? "data/blog-posts.json",
          service_page: `${paths.services_dir ?? "src/app/services"}/<slug>/page.tsx`,
          faq_addition: paths.locations ?? "data/locations.json",
        },
        mutation: { city_page: "push", blog_post: "push", service_page: "pull_request", faq_addition: "push" },
        allowedPaths: [paths.locations ?? "data/locations.json", paths.blog ?? "data/blog-posts.json", `${paths.services_dir ?? "src/app/services"}/`],
        verify: ["JSON parses and keeps the neighbours' keys", "fetch each changed URL: 200, one H1, canonical, JSON-LD"],
        routes: { city: paths.city_route ?? "/service-areas/{slug}", blog: paths.blog_route ?? "/blog/{slug}", service: "/services/{slug}" },
        notes: ["Pushes go to the site's recorded branch of record, as authorised on Sept 14 2026 (publish without a look; Put it back is the safety net)."],
      };
    case "markdown_blog":
      return {
        key,
        label: "Next.js with a Markdown/MDX blog",
        writes: {
          blog_post: `${paths.blog_dir ?? "content/blog"}/<slug>.mdx (front-matter like its neighbours)`,
          city_page: paths.locations ?? "data/locations.json",
          service_page: paths.services_dir ? `${paths.services_dir}/<slug> entry` : "data/services.json entry",
          faq_addition: "data/services.json (per-service faqs[])",
        },
        // A locations.json entry on this shape renders a templated page with
        // no local material, which the city gate does not accept; it is a
        // proposed document until the template carries real local content.
        mutation: { city_page: "proposed_document", blog_post: "push", service_page: "pull_request", faq_addition: "pull_request" },
        allowedPaths: [`${paths.blog_dir ?? "content/blog"}/`, paths.locations ?? "data/locations.json", "data/services.json"],
        verify: ["front-matter keys match the neighbours", "fetch the new URL: 200, one H1, canonical"],
        routes: { city: paths.city_route ?? "/locations/{state}/{city}", blog: paths.blog_route ?? "/blog/{slug}", service: "/services/{slug}" },
        notes: ["The blog directory is the only push path; everything else is reviewed."],
      };
    default:
      return {
        key: "unsupported",
        label: "Unsupported or unknown content contract",
        writes: {},
        mutation: DOC_ONLY,
        allowedPaths: [],
        verify: [],
        routes: {},
        notes: ["The stage files every page and post as a proposed Google Doc in 04 Website plus a change_log row; nothing is pushed."],
      };
  }
}

export interface DetectedContract {
  adapter: ContentAdapterKey;
  paths: ContentPaths;
  /** Present only when the tree actually carries the Foundation layout. */
  foundation?: { brand: string | null; version: "v1"; brands: string[] };
  reasons: string[];
  /** Specific inputs still needed before any write is allowed. */
  missing_inputs: string[];
  /** False until the contract is unambiguous (for the Foundation: a verified active client brand). */
  writable: boolean;
}

export interface DetectOptions {
  /** Brands the site's registry marks fictional (demonstration content, never a client). */
  fictionalBrands?: string[];
  /** When known (read from brands/registry.ts), the brands actually registered. */
  registeredBrands?: string[];
}

/** The fictional demonstration brand shipped with the accepted foundation. */
export const FOUNDATION_FICTIONAL_BRANDS = ["harbor-lane"];

/**
 * Decide the adapter from the repository's file list (what site-push
 * `{read: true}` returns as paths). Order matters: the Foundation layout is
 * unmistakable; the JSON contract needs both data files and the route; the
 * Markdown shape needs a blog dir. Anything else is unsupported.
 *
 * The Foundation's client brand is never guessed. It must be RECORDED on
 * the site (`content_paths.brand`), exist in the tree, not be a fictional
 * demonstration brand, and (when the registry is known) be registered.
 * Anything else is a named missing input and the contract is not writable.
 */
export function detectContentContract(treePaths: string[], recorded: ContentPaths | null = null, options: DetectOptions = {}): DetectedContract {
  const has = (re: RegExp) => treePaths.some((p) => re.test(p));
  const reasons: string[] = [];
  const fictional = new Set(options.fictionalBrands ?? FOUNDATION_FICTIONAL_BRANDS);

  const brandDirs = [...new Set(treePaths.map((p) => p.match(/^brands\/([^/]+)\/site\.config\.ts$/)?.[1]).filter((b): b is string => !!b))].sort();
  if (has(/^brands\/registry\.ts$/) && has(/^lib\/routes\.ts$/) && brandDirs.length > 0) {
    const clientBrands = brandDirs.filter((b) => !fictional.has(b) && (!options.registeredBrands || options.registeredBrands.includes(b)));
    const missing: string[] = [];
    let brand: string | null = null;
    const rec = recorded?.brand?.trim() || null;
    if (!rec) {
      missing.push(
        clientBrands.length === 1
          ? `content_paths.brand is not recorded; the tree carries one client brand (${clientBrands[0]}) — record it on the site row after confirming it is this client's`
          : `content_paths.brand is not recorded; the tree carries ${clientBrands.length} client brands (${clientBrands.join(", ") || "none"}) — record the client's brand on the site row`
      );
    } else if (!brandDirs.includes(rec)) {
      missing.push(`recorded brand "${rec}" has no brands/${rec}/site.config.ts in the tree (present: ${brandDirs.join(", ")})`);
    } else if (fictional.has(rec)) {
      missing.push(`recorded brand "${rec}" is a fictional demonstration brand, not a client brand`);
    } else if (options.registeredBrands && !options.registeredBrands.includes(rec)) {
      missing.push(`recorded brand "${rec}" is not registered in brands/registry.ts (${options.registeredBrands.join(", ")})`);
    } else {
      brand = rec;
    }
    reasons.push(`brands/registry.ts, lib/routes.ts and ${brandDirs.length} brand dir(s) present (${brandDirs.join(", ")}); ${brand ? `client brand ${brand} verified` : "client brand not verified"}`);
    const dir = brand ? `brands/${brand}/content` : undefined;
    return {
      adapter: "foundation_brand_content",
      paths: { adapter: "foundation_brand_content", ...(brand ? { brand, content_dir: dir } : {}), blog_format: "typescript", city_route: "/service-area/{slug}", blog_route: "/blog/{slug}" },
      foundation: { brand, version: "v1", brands: brandDirs },
      reasons,
      missing_inputs: missing,
      writable: brand !== null,
    };
  }

  const locations = recorded?.locations ?? "data/locations.json";
  const blogJson = recorded?.blog && recorded.blog_format !== "markdown" ? recorded.blog : "data/blog-posts.json";
  if (has(new RegExp(`^${escape(locations)}$`)) && has(new RegExp(`^${escape(blogJson)}$`)) && has(/^src\/app\/service-areas\/\[city\]\/page\.tsx$/)) {
    reasons.push(`${locations}, ${blogJson} and src/app/service-areas/[city]/page.tsx present`);
    return {
      adapter: "lucas_json",
      paths: { adapter: "lucas_json", locations, blog: blogJson, blog_format: "json", city_route: "/service-areas/{slug}", blog_route: "/blog/{slug}", services_dir: recorded?.services_dir ?? "src/app/services" },
      reasons,
      missing_inputs: [],
      writable: true,
    };
  }

  const blogDir = recorded?.blog_dir ?? "content/blog";
  if (has(new RegExp(`^${escape(blogDir)}/[^/]+\\.(mdx?|markdown)$`)) && has(/^src\/app\/blog\/\[slug\]\/page\.tsx$/)) {
    reasons.push(`${blogDir}/*.mdx and src/app/blog/[slug]/page.tsx present`);
    const hasLocations = has(new RegExp(`^${escape(locations)}$`));
    return {
      adapter: "markdown_blog",
      paths: {
        adapter: "markdown_blog",
        blog_dir: blogDir,
        blog_format: "markdown",
        blog_route: "/blog/{slug}",
        ...(hasLocations ? { locations, city_route: recorded?.city_route ?? (has(/^src\/app\/locations\/\[state\]\/\[city\]\/page\.tsx$/) ? "/locations/{state}/{city}" : "/locations/{slug}") } : {}),
        ...(has(/^data\/services\.json$/) ? { services_dir: "data/services.json" } : {}),
      },
      reasons,
      missing_inputs: [],
      writable: true,
    };
  }

  reasons.push("no known content contract in the tree");
  return { adapter: "unsupported", paths: { adapter: "unsupported" }, reasons, missing_inputs: ["no supported content contract: every change is a proposed document"], writable: false };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface MutationDecision {
  mode: MutationMode;
  reason: string;
}

/** How a change of this kind reaches this site. */
export function planMutation(adapter: ContentAdapterKey, kind: ChangeKind, paths: ContentPaths = {}): MutationDecision {
  const d = describeAdapter(adapter, paths);
  const mode = d.mutation[kind];
  const where = d.writes[kind];
  if (mode === "proposed_document") {
    return { mode, reason: where ? `${d.label}: a ${kind} is reviewed before it exists on the site — filed as a proposed document` : `${d.label}: no supported write path for ${kind}` };
  }
  return { mode, reason: `${d.label}: ${kind} → ${where} (${mode === "push" ? "authorised push to the branch of record" : "pull request against the branch of record"})` };
}

/**
 * Refuse a write the adapter does not allow. Throws with the reason so the
 * caller (the worker, or a test) sees exactly what was rejected.
 */
export function assertWriteAllowed(adapter: ContentAdapterKey, path: string, content: string, paths: ContentPaths = {}): void {
  if (adapter === "foundation_brand_content" && !paths.brand) {
    throw new Error(`Refusing ${path}: no verified client brand recorded for this Foundation site (content_paths.brand)`);
  }
  const d = describeAdapter(adapter, paths);
  if (path.startsWith("/") || path.includes("..")) throw new Error(`Refusing ${path}: not a repository-relative path`);
  if (!d.allowedPaths.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p))) {
    throw new Error(`Refusing ${path}: outside the ${d.label} write paths (${d.allowedPaths.join(", ") || "none"})`);
  }
  if (adapter === "foundation_brand_content" && /\.json$/i.test(path)) {
    throw new Error(`Refusing ${path}: Foundation typed content is TypeScript — write a typed entry and a registry import, not JSON`);
  }
  if (adapter === "foundation_brand_content" && /\/content\/locations\//.test(path)) {
    throw new Error(`Refusing ${path}: physical locations are a separate registry; a served city goes to content/cities`);
  }
  if (adapter === "lucas_json" && /\.json$/i.test(path)) {
    try {
      JSON.parse(content);
    } catch {
      throw new Error(`Refusing ${path}: the JSON does not parse`);
    }
  }
}

// ── The automatic content-publication exception ───────────────────────────
// Tom's Sept 14 2026 authorisation: routine data entries (a city page or a
// blog post on the Lucas contract, a Markdown post on the BHG shape) may be
// published on a Compass-run site without a look. It is an exception for
// DATA ENTRIES ONLY. site-push grants it when — and only when — every file
// in the request is a push-permitted write path of the site's recorded
// adapter and nothing is deleted. Anything else (a component, a layout, a
// config, a delete, an adapter with no push paths) goes through a preview
// branch and a pull request.
export interface ContentEntryVerdict {
  ok: boolean;
  /** The change kinds the files were matched to (when ok). */
  kinds: ChangeKind[];
  reason: string;
}

/** Does `path` fall under the adapter's declared write path for `kind`? */
function matchesWritePath(adapter: ContentAdapterKey, kind: ChangeKind, path: string, paths: ContentPaths): boolean {
  switch (adapter) {
    case "lucas_json": {
      const loc = paths.locations ?? "data/locations.json";
      const blog = paths.blog ?? "data/blog-posts.json";
      if (kind === "city_page" || kind === "faq_addition") return path === loc;
      if (kind === "blog_post") return path === blog;
      return false;
    }
    case "markdown_blog": {
      const dir = (paths.blog_dir ?? "content/blog").replace(/\/$/, "");
      if (kind === "blog_post") return new RegExp(`^${escape(dir)}/[^/]+\\.(mdx?|markdown)$`).test(path);
      return false;
    }
    default:
      return false;
  }
}

export function validateContentEntry(
  adapter: ContentAdapterKey | null | undefined,
  paths: ContentPaths | null | undefined,
  filePaths: string[],
  deletePaths: string[] = []
): ContentEntryVerdict {
  if (!adapter || adapter === "unsupported") {
    return { ok: false, kinds: [], reason: "no recorded content adapter with push paths: use a preview branch and a pull request" };
  }
  const d = describeAdapter(adapter, paths ?? {});
  const pushKinds = (Object.keys(d.mutation) as ChangeKind[]).filter((k) => d.mutation[k] === "push");
  if (pushKinds.length === 0) {
    return { ok: false, kinds: [], reason: `${d.label}: no change is published without a pull request` };
  }
  if (deletePaths.length > 0) {
    return { ok: false, kinds: [], reason: `deletions (${deletePaths.join(", ")}) are never part of the content-entry exception: use a preview branch and a pull request` };
  }
  if (filePaths.length === 0) {
    return { ok: false, kinds: [], reason: "no files" };
  }
  const kinds = new Set<ChangeKind>();
  for (const p of filePaths) {
    if (p.startsWith("/") || p.includes("..")) return { ok: false, kinds: [], reason: `${p}: not a repository-relative path` };
    const kind = pushKinds.find((k) => matchesWritePath(adapter, k, p, paths ?? {}));
    if (!kind) {
      return { ok: false, kinds: [], reason: `${p} is not a ${d.label} data entry (push paths: ${pushKinds.map((k) => d.writes[k]).join("; ")}): use a preview branch and a pull request` };
    }
    kinds.add(kind);
  }
  return { ok: true, kinds: [...kinds], reason: `${d.label}: ${[...kinds].join(", ")} entries on the recorded write paths` };
}
