// Live-page inventory normalization: what kind of page each URL is, from the
// site's own recorded content contract (sites.content_paths) — never guessed
// from another client's site. Pure.
import { normPath, type Inventory } from "./urls.ts";
import type { SitePage } from "./types.ts";

export type PageKind = "home" | "service" | "location" | "blog" | "other";
export type ClassifiedPage = { path: string; kind: PageKind; slug: string | null; page: SitePage };

export function routePrefix(route: string | undefined): string | null {
  if (!route) return null;
  const i = route.indexOf("{");
  return i > 0 ? route.slice(0, i) : null;
}

export function prefixes(contentPaths: Record<string, string> | null) {
  const servicesDir = contentPaths?.services_dir ?? "";
  return {
    cityPrefix: routePrefix(contentPaths?.city_route) ?? "/service-areas/",
    blogPrefix: routePrefix(contentPaths?.blog_route) ?? "/blog/",
    servicePrefix: servicesDir.startsWith("src/app/") ? `/${servicesDir.slice("src/app/".length).replace(/\/+$/, "")}/` : "/services/",
  };
}

export function classifyPages(inv: Inventory, contentPaths: Record<string, string> | null): ClassifiedPage[] {
  const { cityPrefix, blogPrefix, servicePrefix } = prefixes(contentPaths);
  const out: ClassifiedPage[] = [];
  for (const [path, page] of inv.byPath) {
    const r = inv.resolve(path);
    if (r.state !== "live") continue; // only pages that serve themselves
    let kind: PageKind = "other";
    let slug: string | null = null;
    if (path === "/") kind = "home";
    else if (path.startsWith(cityPrefix)) { kind = "location"; slug = path.slice(cityPrefix.length); }
    else if (path.startsWith(blogPrefix)) { kind = "blog"; slug = path.slice(blogPrefix.length); }
    else if (path.startsWith(servicePrefix)) { kind = "service"; slug = path.slice(servicePrefix.length); }
    out.push({ path, kind, slug, page });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function slugWords(slug: string | null): string {
  return (slug ?? "").replace(/[-_/]+/g, " ").trim();
}

export { normPath };
