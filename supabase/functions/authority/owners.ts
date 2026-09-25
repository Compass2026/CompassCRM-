// Owner-page resolution: the one page that should own a service topic.
// Candidates, in order of authority: the approved service page group's
// target, the service's recorded page, the page most of its keywords target.
// Each candidate is checked against the live inventory; disagreement between
// candidates is a conflict, never silently resolved. Pure.
import type { AuthorityInput, OwnerCandidate, OwnerResolution, PageGroupRow, Reason } from "./types.ts";
import { normPath, type Inventory } from "./urls.ts";

type Service = AuthorityInput["services"][number];

export function serviceGroup(service: Service, groups: PageGroupRow[]): PageGroupRow | null {
  const n = service.name.trim().toLowerCase();
  return groups.find((g) => (g.page_type === "service" || g.page_type === "hub") && g.status === "approved" && g.name.trim().toLowerCase() === n) ?? null;
}

export function resolveOwner(input: AuthorityInput, service: Service, inv: Inventory): OwnerResolution {
  const site = input.authority.site?.url ?? input.client.website_url;
  const cands: OwnerCandidate[] = [];
  const add = (source: OwnerCandidate["source"], url: string | null | undefined) => {
    const path = normPath(url, site);
    if (!url || !path) return;
    const r = inv.resolve(path);
    cands.push({ source, url, path, state: r.state, final_path: r.final_path });
  };
  add("page_group", serviceGroup(service, input.authority.pageGroupsFull)?.target_url);
  add("service", service.page_url);
  // Majority target of the service's own keywords, ignoring the home page.
  const counts = new Map<string, number>();
  for (const k of input.keywords) {
    if (k.service_id !== service.id) continue;
    const p = normPath(k.target_url, site);
    if (p && p !== "/") counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (top) add("keywords", `${site ?? ""}${top[0]}`);

  const reasons: Reason[] = [];
  // Where each candidate really lands.
  const landing = (c: OwnerCandidate) => (c.state === "redirects" ? c.final_path : c.state === "live" ? c.path : null);
  const live = cands.find((c) => landing(c));
  const designated = cands.find((c) => c.source === "page_group") ?? cands[0] ?? null;
  const chosen = live ?? designated;
  const distinct = new Set(cands.map((c) => landing(c) ?? c.path));
  const conflict = distinct.size > 1;
  const pending = input.authority.changeLog.some((c) =>
    c.status === "proposed" && ["page_added", "page_rewrite"].includes(c.change_type) &&
    cands.some((cd) => normPath(String((c.after as { url?: string } | null)?.url ?? ""), site) === cd.path));

  for (const c of cands) {
    const where = c.state === "redirects" ? `redirects to ${c.final_path}` : c.state === "live" ? "live (200)" : c.state === "missing" ? "missing (404)" : c.state === "redirect_loop" ? "a redirect loop (never settles)" : c.state === "not_checked" ? "not in the inventory" : "an error";
    reasons.push({ tag: "FACT", text: `${c.source === "page_group" ? "Page group" : c.source === "service" ? "Service record" : "Keyword targets"} point${c.source === "keywords" ? "" : "s"} at ${c.path}: ${where}.` });
  }
  if (!cands.length) reasons.push({ tag: "FACT", text: "No page group, service page or keyword target names a page for this service." });
  if (conflict) reasons.push({ tag: "FACT", text: `Owner candidates disagree: ${[...distinct].join(" vs ")}.` });
  if (pending) reasons.push({ tag: "FACT", text: "A proposed page for this URL is waiting in change_log (not merged)." });

  const state = !chosen ? "none" : live ? "live" : chosen.state;
  return {
    path: chosen ? (landing(chosen) ?? chosen.path) : null,
    state, source: chosen?.source ?? null, candidates: cands, conflict, pending_proposal: pending, reasons,
  };
}
