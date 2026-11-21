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
  | "json_blog" // Standalone JSON blog with the explicit Compass renderer contract
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
  /** Repository folder a blog's approved hero image is committed to (JSON, Foundation posts-file and Markdown blogs; default public/blog/images). */
  blog_images?: string;
  services_dir?: string;
  content_dir?: string;
  /** Foundation v1 blog contract: the generated posts file the CRM rewrites (brands/<brand>/content/blog/compass-posts.ts). */
  posts_file?: string;
  verify?: string[];
  /**
   * "explicit": the site's Vercel project is deliberately not linked to Git
   * (production changes only by an explicit deployment of a pinned commit).
   * site-push then deploys an authorised content entry itself, and only when
   * production serves the commit the entry is built on (site-push v12).
   */
  vercel_deploy?: "explicit";
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

// v1 moved from 94014af to f928381 on Sept 21 2026 for service-area support
// (address.street / address.zip nullable). The brand content LAYOUT below is
// unchanged by that commit — it touched only the address fields and their
// consumers — so the tree fixture still describes this SHA. The database row
// (foundation_releases.is_current) is what the worker and site-push read;
// this constant is the fallback build-brief.ts uses when no row is loaded.
export const FOUNDATION_V1_SHA = "f928381b3a81e20694571cefc5091392b2c84e86";
export const FOUNDATION_V1_REPO = "Compass2026/showmeelectricalwebsite";

const DOC_ONLY: Record<ChangeKind, MutationMode> = {
  city_page: "proposed_document",
  blog_post: "proposed_document",
  service_page: "proposed_document",
  faq_addition: "proposed_document",
};

/** The folder approved blog hero images are committed to on a JSON, Foundation posts-file or Markdown blog. */
export const DEFAULT_BLOG_IMAGES = "public/blog/images";
const blogImagesDir = (paths: ContentPaths) => (paths.blog_images ?? DEFAULT_BLOG_IMAGES).replace(/\/$/, "");
/** A content-addressed hero image file directly inside the folder: <slug>-<hash12>.<ext>. */
const isBlogImage = (path: string, paths: ContentPaths) =>
  new RegExp(`^${escape(blogImagesDir(paths))}/[a-z0-9]+(-[a-z0-9]+)*-[0-9a-f]{12}\\.(png|jpe?g|webp)$`).test(path);

/**
 * The Foundation's generated Compass posts file, when the site row records a
 * valid one: directly inside brands/<recorded brand>/content/blog/, a .ts file,
 * not the hand-written registry. Null otherwise (no blog publishing push).
 */
export function foundationPostsFile(paths: ContentPaths): string | null {
  const brand = paths.brand ?? "";
  const file = paths.posts_file ?? "";
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(brand)) return null;
  if (!new RegExp(`^brands/${escape(brand)}/content/blog/[a-z0-9]+(-[a-z0-9]+)*\\.ts$`).test(file) || file.endsWith("/index.ts")) return null;
  return file;
}

export function describeAdapter(key: ContentAdapterKey, paths: ContentPaths = {}): AdapterDescription {
  switch (key) {
    case "foundation_brand_content": {
      const brand = paths.brand ?? "<brand>";
      const dir = paths.content_dir ?? `brands/${brand}/content`;
      const posts = foundationPostsFile(paths);
      // Layout of the accepted foundation (94014af): brands/<brand>/content/
      // {blog,cities,services,legal}/ with an index.ts registry in each —
      // verified against the tree fixture in tests/content-adapters.test.mjs.
      return {
        key,
        label: "Compass Website Foundation v1 (typed brand content)",
        writes: {
          city_page: `${dir}/cities/<slug>.ts + registry entry in ${dir}/cities/index.ts`,
          blog_post: posts
            ? `${posts} (generated Compass posts file; one approved Article appended, + its approved hero image in ${blogImagesDir(paths)}/ when the site opted in)`
            : `${dir}/blog/<slug>.ts + registry entry in ${dir}/blog/index.ts`,
          service_page: `${dir}/services/<slug>.ts + registry entry in ${dir}/services/index.ts`,
          faq_addition: "the page's typed content file",
        },
        // Typed TypeScript content is compiled: nothing reaches the branch of
        // record without a build, the crawl and the manifest passing, so every
        // change is a pull request with that evidence — never a data push.
        // The one exception (Nov 2026): a site that advertises the Compass blog
        // contract (compass-blog.json) and records its generated posts file
        // takes an approved blog post as a data entry in that file only; the
        // registry's build check refuses a duplicate slug or a wrong path.
        mutation: { city_page: "pull_request", blog_post: posts ? "push" : "pull_request", service_page: "pull_request", faq_addition: "pull_request" },
        allowedPaths: [`${dir}/`, ...(posts ? [`${blogImagesDir(paths)}/`] : []), "docs/page-plan.md", "docs/route-manifest.md"],
        verify: ["npm run typecheck", `COMPASS_BRAND=${brand} npx next build`, `COMPASS_BRAND=${brand} npm run qa:manifest`, "npm run qa:crawl -- <preview> --host <production host> --assets remap"],
        routes: { city: "/service-area/{slug}", blog: "/blog/{slug}", service: "/services/{hub}/{slug}", location: "/locations/{slug}" },
        notes: [
          "Served-city pages live at /service-area/[city]; physical locations are a separate registry at /locations/[slug]. Never write a city into the locations registry.",
          "Content files are TypeScript, not JSON: an entry is a typed object plus a registry import. The city gate (coverage confirmed + distinctive local material) applies before a city page is registered.",
          ...(posts ? [`Approved blog posts are published as data entries in ${posts} (the JSON between /* compass:begin */ and /* compass:end */); hand-written posts, pages and components stay pull requests.`] : []),
        ],
      };
    }
    case "json_blog":
      return {
        key, label: "Compass JSON blog",
        writes: { blog_post: `${paths.blog ?? "data/blog-posts.json"} (+ its approved hero image in ${blogImagesDir(paths)}/)` },
        mutation: { ...DOC_ONLY, blog_post: "push" },
        allowedPaths: [paths.blog ?? "data/blog-posts.json", `${blogImagesDir(paths)}/`],
        verify: ["JSON parses; existing articles remain unchanged", "Verify complete article, canonical, SEO and release marker on the live URL"],
        routes: { blog: paths.blog_route ?? "/blog/{slug}" },
        notes: ["Only approved blog data may be pushed. Other website changes require a separate reviewed implementation."],
      };
    case "lucas_json":
      return {
        key,
        label: "Sept 14 content contract (JSON data files)",
        writes: {
          city_page: paths.locations ?? "data/locations.json",
          blog_post: `${paths.blog ?? "data/blog-posts.json"} (+ its approved hero image in ${blogImagesDir(paths)}/)`,
          service_page: `${paths.services_dir ?? "src/app/services"}/<slug>/page.tsx`,
          faq_addition: paths.locations ?? "data/locations.json",
        },
        mutation: { city_page: "push", blog_post: "push", service_page: "pull_request", faq_addition: "push" },
        allowedPaths: [paths.locations ?? "data/locations.json", paths.blog ?? "data/blog-posts.json", `${blogImagesDir(paths)}/`, `${paths.services_dir ?? "src/app/services"}/`],
        verify: ["JSON parses and keeps the neighbours' keys", "fetch each changed URL: 200, one H1, canonical, JSON-LD"],
        routes: { city: paths.city_route ?? "/service-areas/{slug}", blog: paths.blog_route ?? "/blog/{slug}", service: "/services/{slug}" },
        notes: ["Pushes go to the site's recorded branch of record, as authorised on Sept 14 2026 (publish without a look; Put it back is the safety net)."],
      };
    case "markdown_blog":
      return {
        key,
        label: "Next.js with a Markdown/MDX blog",
        writes: {
          blog_post: `${paths.blog_dir ?? "content/blog"}/<slug>.mdx (front-matter like its neighbours; + its approved hero image in ${blogImagesDir(paths)}/)`,
          city_page: paths.locations ?? "data/locations.json",
          service_page: paths.services_dir ? `${paths.services_dir}/<slug> entry` : "data/services.json entry",
          faq_addition: "data/services.json (per-service faqs[])",
        },
        // A locations.json entry on this shape renders a templated page with
        // no local material, which the city gate does not accept; it is a
        // proposed document until the template carries real local content.
        mutation: { city_page: "proposed_document", blog_post: "push", service_page: "pull_request", faq_addition: "pull_request" },
        allowedPaths: [`${paths.blog_dir ?? "content/blog"}/`, `${blogImagesDir(paths)}/`, paths.locations ?? "data/locations.json", "data/services.json"],
        verify: ["front-matter keys match the neighbours", "fetch the new URL: 200, one H1, canonical"],
        routes: { city: paths.city_route ?? "/locations/{state}/{city}", blog: paths.blog_route ?? "/blog/{slug}", service: "/services/{slug}" },
        notes: ["The blog directory (and an approved post's content-addressed hero image beside it) is the only push path; everything else is reviewed."],
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
  /**
   * The repository's compass-blog.json (raw text or parsed), when it has one.
   * The file is the site's own declaration of its blog renderer; a tree path
   * alone never says which adapter it declares.
   */
  compassBlog?: string | Record<string, unknown> | null;
}

function parseCompassBlog(v: DetectOptions["compassBlog"]): Record<string, unknown> | null {
  if (!v) return null;
  if (typeof v !== "string") return v;
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
  const contract = has(/^compass-blog\.json$/) ? parseCompassBlog(options.compassBlog) : null;
  const contractBrand = contract?.adapter === "foundation_brand_content" && typeof contract.brand === "string" ? contract.brand : null;

  const configBrands = [...new Set(treePaths.map((p) => p.match(/^brands\/([^/]+)\/site\.config\.ts$/)?.[1]).filter((b): b is string => !!b))].sort();
  const foundationLayout = has(/^brands\/registry\.ts$/) && has(/^lib\/routes\.ts$/) && configBrands.length > 0;
  const declaredFoundation = !!contractBrand && has(new RegExp(`^brands/${escape(contractBrand)}/content/`));
  // A brand the contract declares and whose content directory is in the tree counts as present.
  const brandDirs = [...new Set([...configBrands, ...(declaredFoundation ? [contractBrand!] : [])])].sort();
  if (foundationLayout || declaredFoundation) {
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
    reasons.push(foundationLayout
      ? `brands/registry.ts, lib/routes.ts and ${brandDirs.length} brand dir(s) present (${brandDirs.join(", ")}); ${brand ? `client brand ${brand} verified` : "client brand not verified"}`
      : `compass-blog.json declares foundation_brand_content for brands/${contractBrand}/content/; ${brand ? `client brand ${brand} verified` : "client brand not verified"}`);
    const dir = brand ? `brands/${brand}/content` : undefined;
    // The blog contract: publishing is a data entry in the generated posts
    // file only when compass-blog.json declares it for THIS (recorded) brand
    // and the file is in the tree. Otherwise blog posts stay pull requests —
    // a bad contract never blocks the rest of the Foundation work.
    let postsFile: string | null = null;
    if (contract && contract.adapter === "foundation_brand_content" && brand) {
      const candidate = foundationPostsFile({ brand, posts_file: typeof contract.posts_file === "string" ? contract.posts_file : undefined });
      if (contract.brand !== brand) reasons.push(`compass-blog.json brand "${String(contract.brand)}" is not the recorded brand ${brand}: blog posts stay pull requests`);
      else if (contract.version !== 1 || contract.keyword_provenance !== true || contract.blocks !== true || contract.seo_fields !== true || contract.blog_route !== "/blog/{slug}") reasons.push("compass-blog.json does not declare the complete Foundation blog contract (version 1, keyword_provenance, blocks, seo_fields, /blog/{slug}): blog posts stay pull requests");
      else if (!candidate) reasons.push(`compass-blog.json posts_file is not a generated .ts file in brands/${brand}/content/blog/: blog posts stay pull requests`);
      else if (!treePaths.includes(candidate)) reasons.push(`compass-blog.json names ${candidate}, which is not in the tree: blog posts stay pull requests`);
      else { postsFile = candidate; reasons.push(`Compass blog contract: approved posts are data entries in ${candidate}`); }
    }
    const heroDir = postsFile && contract?.hero_image === true && typeof contract.hero_image_dir === "string" ? contract.hero_image_dir : null;
    return {
      adapter: "foundation_brand_content",
      paths: { adapter: "foundation_brand_content", ...(brand ? { brand, content_dir: dir } : {}), blog_format: "typescript", city_route: "/service-area/{slug}", blog_route: "/blog/{slug}", ...(postsFile ? { posts_file: postsFile } : {}), ...(heroDir ? { blog_images: heroDir } : {}) },
      foundation: { brand, version: "v1", brands: brandDirs },
      reasons,
      missing_inputs: missing,
      writable: brand !== null,
    };
  }

  if (has(/^compass-blog\.json$/) && has(/^data\/blog-posts\.json$/)
      && has(/^src\/content\/compass-blog\.ts$/) && has(/^src\/routing\.ts$/)
      && has(/^scripts\/prerender\.m?js$/)) {
    return { adapter: "json_blog", paths: { adapter: "json_blog", blog: "data/blog-posts.json", blog_format: "json", blog_route: recorded?.blog_route ?? "/blog/{slug}/" },
      reasons: ["Explicit Compass blog contract, JSON loader, routes and prerender pipeline are present"], missing_inputs: [], writable: true };
  }

  // The Next.js JSON blog (Pensacola, compass/launch-readiness): the contract
  // file itself declares json_blog, with the JSON data and its loader. The
  // route is the site's own (Pensacola serves posts at the root), so it is
  // never assumed: it must be recorded on the site row.
  if (contract?.adapter === "json_blog" && has(/^data\/blog-posts\.json$/) && has(/^src\/content\/compass-blog\.ts$/)) {
    const route = recorded?.blog_route ?? null;
    const heroDir = typeof contract.hero_image_dir === "string" ? contract.hero_image_dir : null;
    return {
      adapter: "json_blog",
      paths: { adapter: "json_blog", blog: "data/blog-posts.json", blog_format: "json", ...(route ? { blog_route: route } : {}), ...(heroDir ? { blog_images: heroDir } : {}) },
      reasons: ["compass-blog.json declares json_blog; data/blog-posts.json and its loader src/content/compass-blog.ts are present"],
      missing_inputs: route ? [] : ["content_paths.blog_route is not recorded: record the route the site serves its posts at (e.g. /{slug} or /blog/{slug})"],
      writable: !!route,
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
  if ((adapter === "lucas_json" || adapter === "json_blog") && /\.json$/i.test(path)) {
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
    // A blog entry may carry its approved hero image (content-addressed file).
    case "json_blog": return kind === "blog_post" && (path === (paths.blog ?? "data/blog-posts.json") || isBlogImage(path, paths));
    case "lucas_json": {
      const loc = paths.locations ?? "data/locations.json";
      const blog = paths.blog ?? "data/blog-posts.json";
      if (kind === "city_page" || kind === "faq_addition") return path === loc;
      if (kind === "blog_post") return path === blog || isBlogImage(path, paths);
      return false;
    }
    case "foundation_brand_content": {
      // An approved post may carry its hero image (content-addressed file);
      // validateContentEntry also requires the posts file in the same request.
      const posts = foundationPostsFile(paths);
      return kind === "blog_post" && !!posts && (path === posts || isBlogImage(path, paths));
    }
    case "markdown_blog": {
      const dir = (paths.blog_dir ?? "content/blog").replace(/\/$/, "");
      // A post may carry its approved hero image (content-addressed file);
      // validateContentEntry also requires the post itself in the same request.
      if (kind === "blog_post") return new RegExp(`^${escape(dir)}/[^/]+\\.(mdx?|markdown)$`).test(path) || isBlogImage(path, paths);
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
  // Foundation (Nov 2026): a hero image is only ever part of a post's commit,
  // so an image without the generated posts file beside it is not a data entry.
  const foundationPosts = adapter === "foundation_brand_content" ? foundationPostsFile(paths ?? {}) : null;
  if (foundationPosts && !filePaths.includes(foundationPosts) && filePaths.some((p) => isBlogImage(p, paths ?? {}))) {
    return { ok: false, kinds: [], reason: `a hero image is published only in the same commit as its post (${foundationPosts}): use a preview branch and a pull request` };
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
  // Markdown blog (Nov 2026): a hero image is only ever part of its own post's
  // commit. An image with no <blog_dir>/<slug>.mdx beside it in the request is
  // not a data entry.
  if (adapter === "markdown_blog") {
    const dir = (paths?.blog_dir ?? "content/blog").replace(/\/$/, "");
    for (const p of filePaths.filter((f) => isBlogImage(f, paths ?? {}))) {
      const slug = p.slice(p.lastIndexOf("/") + 1).replace(/-[0-9a-f]{12}\.(png|jpe?g|webp)$/, "");
      if (!filePaths.includes(`${dir}/${slug}.mdx`)) {
        return { ok: false, kinds: [], reason: `${p}: a hero image is published only in the same commit as its post (${dir}/${slug}.mdx): use a preview branch and a pull request` };
      }
    }
  }
  return { ok: true, kinds: [...kinds], reason: `${d.label}: ${[...kinds].join(", ")} entries on the recorded write paths` };
}
