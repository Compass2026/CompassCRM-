// Lucas Construction, Sept 25 2026, trimmed for the Authority Engine tests:
// the drafter fixture's Client Intelligence plus coverage, performance and a
// site inventory shaped like the live site (titles, H1s, redirects and 404s
// as fetched read-only that day). Keyword and GSC rows are a representative
// subset, not the full export.
import { lucas as drafterLucas, SITE, PAGE, ROOF, KW, OC, WARRANTY, GAZETTEER } from "./drafter-lucas.mjs";

export { SITE, PAGE, ROOF, KW, OC, WARRANTY };
export const REPAIR = "c1c55a67-bc9f-43d1-a3a6-ad9bfe96841d";
export const STORM = "2d53aa66-3353-4ea7-b5b9-fd1961a69788";
export const APPROVED_POST = "ea0600b3-024d-4784-b761-4a12b8e83a74";
export const REJECTED_POST = "226ccecd-f0a4-41ba-a89f-2943e4125408";
export const NOW = "2026-09-25T19:00:00.000Z";

const u = (p) => `${SITE}${p}`;
const kw = (id, keyword, intent, service_id, target, extra = {}) => ({
  id, keyword, intent, intent_note: null, is_active: true, is_tracked: true, is_money: false,
  service_id, target_url: target === null ? null : u(target), priority: "p2", ...extra,
});
export const page = (path, over = {}) => ({
  url: u(path), status: 200, final_url: u(path), final_status: 200, redirect_loop: false, in_sitemap: true,
  title: null, h1: null, h2: [], canonical: u(path), words: 800, text: "", ...over,
});

export function lucasAuthority() {
  const base = drafterLucas();
  const input = {
    ...base,
    services: [
      { id: ROOF, name: "Roof Replacement", status: "approved", page_url: PAGE, primary_keyword_id: KW, parent_service_id: null, segment: "Roofing" },
      { id: REPAIR, name: "Roof Repair", status: "approved", page_url: u("/roofing-repairs/"), primary_keyword_id: "kw-repair", parent_service_id: null, segment: "Roofing" },
      { id: STORM, name: "Storm Damage & Insurance Claims", status: "approved", page_url: null, primary_keyword_id: "kw-storm", parent_service_id: null, segment: "Roofing" },
      { id: "svc-draft", name: "Metal Roofing", status: "draft", page_url: u("/services/metal"), primary_keyword_id: null, parent_service_id: null, segment: "Roofing" },
    ],
    keywords: [
      kw(KW, "roof replacement wentzville", "commercial", ROOF, "/services/roof-replacement", { is_money: true, priority: "p1" }),
      kw("kw-info", "how long does a roof last", "informational", ROOF, "/services/roof-replacement", { priority: "p3" }),
      kw("kw-trans", "new roof installation wentzville", "transactional", ROOF, "/services/roof-replacement", { priority: "p1" }),
      kw("kw-home1", "roofer in wentzville mo", "commercial", ROOF, "/", { is_money: true, priority: "p1" }),
      kw("kw-home2", "local roofing contractor wentzville", "commercial", ROOF, "/"),
      kw("kw-best", "best roofing company wentzville", "commercial", ROOF, "/"),
      kw("kw-asphalt", "asphalt shingle roofing wentzville", "commercial", ROOF, "/services/roof-replacement"),
      kw("kw-ofallon", "roofer in o'fallon mo", "commercial", ROOF, "/service-areas/ofallon"),
      kw("kw-comm", "commercial roofing company wentzville", "commercial", ROOF, "/services/commercial-roofing"),
      kw("kw-repair", "roof repair wentzville mo", "navigational", REPAIR, "/services/roof-repair", { is_money: true, priority: "p1" }),
      kw("kw-storm", "storm damage roofing wentzville mo", "commercial", STORM, "/services/storm-damage", { is_money: true, priority: "p1" }),
      kw("kw-lights", "christmas light installation wentzville", null, null, null),
      kw("kw-metal", "metal roof installation wentzville", "commercial", "svc-draft", "/services/metal"),
    ],
    pageGroups: [
      { id: "046dba3b-fae7-44d5-a1a8-887d30602d85", name: "Roof Replacement", status: "approved", target_url: PAGE, primary_keyword_id: KW },
      { id: "pg-repair", name: "Roof Repair", status: "approved", target_url: u("/services/roof-repair"), primary_keyword_id: "kw-repair" },
      { id: "pg-storm", name: "Storm Damage & Insurance Claims", status: "approved", target_url: u("/services/storm-damage"), primary_keyword_id: "kw-storm" },
    ],
  };
  const group = (id, name, page_type, target, primary = null) => ({
    id, name, page_type, status: "approved", city_tier: page_type === "city" ? "p1" : null, target_url: u(target),
    primary_keyword_id: primary, supporting_keyword_ids: [],
  });
  const gsc = (query, path, impressions, position, keyword_id = null, window = ["2026-08-25", "2026-09-21"]) => ({
    query, page: path ? u(path) : null, impressions, clicks: Math.floor(impressions / 20), avg_position: position,
    period_start: window[0], period_end: window[1], keyword_id,
  });
  const OLD = ["2026-08-14", "2026-09-10"];
  input.authority = {
    now: NOW,
    site: { url: SITE, work_mode: "upgrade_existing", adapter: "lucas_json", content_paths: {
      blog: "data/blog-posts.json", locations: "data/locations.json", blog_route: "/blog/{slug}",
      city_route: "/service-areas/{slug}", blog_format: "json", services_dir: "src/app/services",
    } },
    pageGroupsFull: [
      group("046dba3b-fae7-44d5-a1a8-887d30602d85", "Roof Replacement", "service", "/services/roof-replacement", KW),
      group("pg-repair", "Roof Repair", "service", "/services/roof-repair", "kw-repair"),
      group("pg-storm", "Storm Damage & Insurance Claims", "service", "/services/storm-damage", "kw-storm"),
      group("pg-home", "Home", "home", "/"),
      group("pg-wentzville", "Wentzville", "city", "/service-areas/wentzville"),
      group("pg-ofallon", "O'Fallon", "city", "/service-areas/ofallon"),
    ],
    keywordExtras: [{ id: KW, volume: 90, cpc: 18, city: "Wentzville" }, { id: "kw-home1", volume: 50, cpc: 12, city: "Wentzville" }],
    moneyKeywordIds: [KW, "kw-home1", "kw-repair", "kw-storm"],
    gsc: [
      gsc("roof replacement wentzville", "/", 120, 4.2, KW),
      gsc("roofer in wentzville mo", "/", 90, 3.1, "kw-home1"),
      gsc("wentzville roof replacement", "/", 40, 5.0),
      gsc("roof replacement wentzville", "/", 300, 4.0, KW, OLD), // an older, overlapping window: never summed
      gsc("roof repair wentzville mo", "/", 70, 2.0, "kw-repair"),
      gsc("roof repair near me", "/roofing-repairs/", 30, 9.0),
      gsc("storm damage roofing wentzville mo", "/", 15, 6.0, "kw-storm"),
      gsc("wentzville roofing", "/blog/the-benefits-of-hiring-a-local-wentzville-roofing-company", 12, 11.0),
      gsc("wentzville roofing", "/blog/what-sets-lucas-construction-apart-from-out-of-town-roofers", 8, 14.0),
      gsc("commercial roofing wentzville", "/services/commercial-roofing", 6, 22.0),
    ],
    ranks: [
      { keyword_id: KW, result_type: "organic", position: 4, url_ranked: u("/"), recorded_at: "2026-09-14T06:00:00Z" },
      { keyword_id: KW, result_type: "map_pack", position: 1, url_ranked: u("/"), recorded_at: "2026-09-14T06:00:00Z" },
    ],
    socialPosts: [
      { id: APPROVED_POST, platform: "google_business", search_intent: "commercial", service_id: ROOF, keyword_id: KW, review_status: "approved",
        publish_status: "not_scheduled", review_note: null, created_at: "2026-09-25T18:01:29Z", reviewed_at: "2026-09-25T18:20:00Z",
        drafter_run_id: "run-1", claim_ids: [WARRANTY, OC], copy: "Thinking about a roof replacement for your Wentzville home?" },
      { id: REJECTED_POST, platform: "google_business", search_intent: "commercial", service_id: ROOF, keyword_id: KW, review_status: "rejected",
        publish_status: "not_scheduled", review_note: "This was only a rejection test", created_at: "2026-09-25T18:26:45Z", reviewed_at: "2026-09-25T18:40:00Z",
        drafter_run_id: "run-2", claim_ids: [WARRANTY, OC], copy: "A second test post." },
    ],
    contentPosts: [],
    changeLog: [
      { change_type: "page_added", object_type: "site", status: "proposed", created_at: "2026-09-15T21:05:44Z", after: { url: u("/services/roof-repair"), title: "Roof repair in Wentzville, MO" } },
      { change_type: "page_added", object_type: "site", status: "proposed", created_at: "2026-09-15T21:05:44Z", after: { url: u("/services/storm-damage"), title: "Storm damage roofing in Wentzville" } },
    ],
    inventory: { fetched_at: "2026-09-25T19:02:38Z", pages: [
      page("/", { title: "LUCAS Construction & Roofing | Wentzville, MO | Premier St. Louis Roofer", h1: "Premier St. Louis Roofing & Exteriors Contractor.", h2: ["Expert Solutions for Missouri Weather."] }),
      page("/services/roof-replacement", { title: "Roof Replacement St. Louis | Lucas Construction & Roofing", h1: "Expert Roof Replacement in St. Louis.", h2: ["Two Systems. One Certified Team.", "Owens Corning Preferred Contractor"] }),
      page("/services/commercial-roofing", { title: "Commercial Roofing St. Louis | Flat Roof Contractors | Lucas", h1: "Commercial Roofing" }),
      page("/services/roof-repair", { status: 404, final_status: 404 }),
      page("/services/storm-damage", { status: 404, final_status: 404 }),
      page("/roofing-repairs/", { status: 308, final_url: u("/services/roof-replacement"), in_sitemap: false, title: "Roof Replacement St. Louis | Lucas Construction & Roofing" }),
      page("/service-areas/wentzville", { title: "Roofing Contractor in Wentzville, MO | Lucas Construction" }),
      page("/service-areas/ofallon", { title: "Roofing Contractor in O'Fallon, MO | Lucas Construction" }),
      page("/service-areas/troy", { title: "Roofing Contractor in Troy, MO | Lucas Construction" }),
      page("/blog/avoid-these-5-common-roofing-scams-in-missouri", { title: "Avoid These 5 Common Roofing Scams in Missouri", text: "Watch out for the storm chaser and out-of-town crews." }),
      page("/blog/the-benefits-of-hiring-a-local-wentzville-roofing-company", { title: "The Benefits of Hiring a Local Wentzville Roofing Company", text: "Unlike out-of-town roofers…" }),
      page("/blog/what-sets-lucas-construction-apart-from-out-of-town-roofers", { title: "What Sets Lucas Construction Apart from Out-of-Town Roofers" }),
      page("/blog/the-ultimate-guide-to-roof-maintenance-protecting-your-home-year-round", { title: "The Ultimate Guide to Roof Maintenance" }),
      page("/blog/how-to-choose-the-best-roofing-material-for-your-home-in-missouri", { title: "How to Choose the Best Roofing Material for Your Home in Missouri" }),
    ] },
    places: [...GAZETTEER, "Saint Louis", "Troy", "Chesterfield"],
  };
  return input;
}
