// Authority reconciliation (C2) as pure rules: which rows an opportunity's
// reconciliation offers, which are available and why not, exactly what each
// writes (before → after), the payload and the expected state authority_apply
// (0050 / 0051 / 0052) must still find, and how its answers read. No network,
// no database: the server action reads, normalises and hands the facts in.
// authority_apply is the judge; these rules only shape the preview.
//
// Rows always come from structured fields (the run's report.keywords, an
// opportunity's candidate_paths), never from reason text.
import { MAX_SELECTED } from "./authority-decisions.ts";

export { MAX_SELECTED };

export type ReconcileAction = "set_service_page" | "rehome_keywords" | "record_content" | "map_keywords";
export const RECONCILE_ACTIONS: readonly ReconcileAction[] = ["set_service_page", "rehome_keywords", "record_content", "map_keywords"];
export const RECORD_KEY = "data_fix:record-live-blog-posts";
export const UNMAPPED_KEY = "data_fix:unmapped-keywords";

export const MARKET_FIRST = "This keyword references an unapproved market. Decide on that market first.";
export const NOT_COMPASS = "Not produced by Compass.";
export const NEEDS_V13 = "This analysis predates the structured page list. Refresh the analysis to list the pages.";

export function reconcileAction(key: string): ReconcileAction | null {
  if (key.startsWith("data_fix:service-page:")) return "set_service_page";
  if (key.startsWith("data_fix:keyword-ownership:")) return "rehome_keywords";
  if (key === RECORD_KEY) return "record_content";
  if (key === UNMAPPED_KEY) return "map_keywords";
  return null;
}
export function reconcileServiceId(key: string): string | null {
  const m = /^data_fix:(?:service-page|keyword-ownership):([0-9a-f-]{36})$/i.exec(key);
  return m ? m[1].toLowerCase() : null;
}
export const ACTION_LABEL: Record<ReconcileAction, string> = {
  set_service_page: "Set service page…",
  rehome_keywords: "Re-home keywords…",
  record_content: "Record pages…",
  map_keywords: "Map keywords…",
};
// Actions whose preview is a list of rows the teammate ticks (none preselected).
export const SELECTS_ROWS: readonly ReconcileAction[] = ["rehome_keywords", "record_content", "map_keywords"];

// ── The preview's shapes ────────────────────────────────────────────────────
export type Change = { record: string; field: string; before: string; after: string };
export type MapOption = { service_id: string; name: string; destination_url: string | null; enabled: boolean; reason: string | null };
export type RowLink = { key: string; label: string };
export type ReconcileRow = {
  id: string;                                   // keyword id or page path
  label: string;                                // the keyword or the path
  enabled: boolean;
  reason: string | null;                        // why it is unavailable (or a note)
  changes: Change[];                            // every field the row writes
  links: RowLink[];                             // decisions that unblock it
  payload: Record<string, unknown> | null;      // the row authority_apply takes
  expected: Record<string, unknown> | null;     // what authority_apply must still find (0052 bindings included)
  options?: MapOption[];                        // map_keywords: the services it may go to
};

const show = (v: string | null | undefined) => (v == null || v === "" ? "—" : v);

// A keyword as the run's report classified it (report.keywords), and as it stands now.
export type ReportKeyword = {
  keyword_id: string; keyword: string; service_id: string | null; role: string; flags: string[];
  unapproved_places?: string[];
  home_check?: { fit: string; eligible: boolean; reason: string } | null;
};
export type CurrentKeyword = { id: string; keyword: string; service_id: string | null; target_url: string | null; target_path: string | null };
export type GroupRef = { id: string; name: string };
export type TargetGroup = GroupRef & { target_url: string | null; path: string | null; live: boolean };

// ── Set service page ────────────────────────────────────────────────────────
export function servicePageRow(a: {
  service: { id: string; name: string; status: string; page_url: string | null; page_path: string | null } | null;
  group: TargetGroup | null;
}): ReconcileRow {
  const base = { id: a.service?.id ?? "service", label: a.service?.name ?? "Service", links: [] as RowLink[], payload: null, expected: null, changes: [] as Change[] };
  if (!a.service) return { ...base, enabled: false, reason: "The service is gone; refresh the analysis." };
  if (a.service.status !== "approved") return { ...base, enabled: false, reason: "Only an approved service takes a service page." };
  if (!a.group) return { ...base, enabled: false, reason: "No approved page group supports this service." };
  if (!a.group.path) return { ...base, enabled: false, reason: "The page group's page is not on the client's site." };
  if (!a.group.live) return { ...base, enabled: false, reason: `${a.group.path} is not live in the latest site snapshot.` };
  if (a.service.page_path === a.group.path) return { ...base, enabled: false, reason: `The service page is already ${a.group.path}; refresh the analysis.` };
  return {
    ...base, enabled: true, reason: null,
    changes: [{ record: `services · ${a.service.name}`, field: "page_url", before: show(a.service.page_url), after: a.group.target_url! }],
    payload: {}, expected: { page_url: a.service.page_url, target_url: a.group.target_url },
  };
}

// ── Re-home keywords ────────────────────────────────────────────────────────
export function rehomeRows(a: {
  service: { id: string; name: string };
  report: ReportKeyword[];
  current: Map<string, CurrentKeyword>;
  serviceGroup: TargetGroup | null;
  home: (TargetGroup & { valid: boolean; reason: string | null; supporting: string[]; primary: string | null }) | null;
  primaryIds: Set<string>;                      // services' and service / hub groups' primary keywords
  listing: Map<string, GroupRef[]>;             // service / hub groups whose supporting list holds the keyword
  ownerKeys: Set<string>;                       // confirm_owner:<id> keys in the latest report
}): ReconcileRow[] {
  const candidates = a.report.filter((k) => k.service_id === a.service.id && k.flags.includes("homepage_pollution"));
  return candidates.map((k) => {
    const cur = a.current.get(k.keyword_id);
    const off = (reason: string, links: RowLink[] = []): ReconcileRow =>
      ({ id: k.keyword_id, label: k.keyword, enabled: false, reason, changes: [], links, payload: null, expected: null });
    if (!cur) return off("The keyword is gone; refresh the analysis.");
    if (cur.service_id !== a.service.id || cur.target_path !== "/") return off("Changed since the analysis; refresh it first.");
    const before = { service_id: cur.service_id, target_url: cur.target_url };
    if (k.flags.includes("home_ambiguous")) {
      const key = `confirm_owner:${k.keyword_id}`;
      return off("Which page owns it needs a person's decision first (Needs Decision › Ownership).",
        a.ownerKeys.has(key) ? [{ key, label: "Ownership decision" }] : []);
    }
    if (k.flags.includes("home_eligible")) {
      const h = a.home;
      if (!h || !h.valid) return off(h?.reason ?? "Home needs exactly one approved Home page group targeting the home page.");
      if (a.primaryIds.has(k.keyword_id)) return off(`"${k.keyword}" is a service's primary keyword; change that before re-homing it to Home.`);
      const leaves = a.listing.get(k.keyword_id) ?? [];
      const onHome = h.primary === k.keyword_id || h.supporting.includes(k.keyword_id);
      const changes: Change[] = [
        { record: `keywords · ${k.keyword}`, field: "service_id", before: a.service.name, after: "— (no service; Home owns it)" },
        { record: `keywords · ${k.keyword}`, field: "target_url", before: show(cur.target_url), after: h.target_url! },
        ...leaves.map((g) => ({ record: `page_groups · ${g.name}`, field: "supporting_keyword_ids", before: `lists "${k.keyword}"`, after: `"${k.keyword}" removed` })),
        { record: `page_groups · ${h.name}`, field: "supporting_keyword_ids", before: onHome ? `lists "${k.keyword}"` : "—", after: onHome ? "unchanged (already listed)" : `"${k.keyword}" added` },
      ];
      return {
        id: k.keyword_id, label: k.keyword, enabled: true, reason: null, changes, links: [],
        payload: { keyword_id: k.keyword_id, destination: "home" },
        expected: { keyword_id: k.keyword_id, ...before, destination_url: h.target_url, removed_from: leaves.map((g) => g.id).sort() },
      };
    }
    const g = a.serviceGroup;
    if (!g || !g.live) return off(`${a.service.name} has no live page yet, so there is nowhere to re-home it.`);
    return {
      id: k.keyword_id, label: k.keyword, enabled: true, reason: null, links: [],
      changes: [
        { record: `keywords · ${k.keyword}`, field: "service_id", before: a.service.name, after: `${a.service.name} (unchanged)` },
        { record: `keywords · ${k.keyword}`, field: "target_url", before: show(cur.target_url), after: g.target_url! },
      ],
      payload: { keyword_id: k.keyword_id, destination: "service_page" },
      expected: { keyword_id: k.keyword_id, ...before, destination_url: g.target_url },
    };
  });
}

// ── Record existing content ─────────────────────────────────────────────────
export type PageFact = { state: string; title: string | null; url: string | null };
export function recordRows(a: {
  candidates: string[] | undefined;             // the opportunity's candidate_paths (v1.3)
  prefix: string;                               // the blog route's prefix, as authority_apply reads it
  pages: Map<string, PageFact>;                 // authority_page_state per candidate
  recorded: Set<string>;                        // normalised paths already in content_posts
}): ReconcileRow[] | null {
  if (!a.candidates) return null;
  return a.candidates.map((path) => {
    const off = (reason: string): ReconcileRow => ({ id: path, label: path, enabled: false, reason, changes: [], links: [], payload: null, expected: null });
    if (a.recorded.has(path)) return off("Already recorded in content_posts.");
    if (!path.startsWith(a.prefix) || path.length <= a.prefix.length) return off(`Not under the blog route (${a.prefix}).`);
    const p = a.pages.get(path);
    if (!p || p.state !== "live") return off(`Not live in the latest site snapshot (${(p?.state ?? "not_checked").replace(/_/g, " ")}).`);
    return {
      id: path, label: path, enabled: true, reason: null, links: [],
      changes: [
        { record: "content_posts · new row", field: "title", before: "—", after: show(p.title) },
        { record: "content_posts · new row", field: "url", before: "—", after: show(p.url) },
        { record: "content_posts · new row", field: "status · origin", before: "—", after: `published · site_inventory (${NOT_COMPASS})` },
      ],
      payload: { path }, expected: null,
    };
  });
}
// The pages still to record: the latest analysis's candidates not yet in content_posts.
export function remainingPaths(candidates: string[] | undefined, recorded: Set<string>): string[] | null {
  return candidates ? candidates.filter((p) => !recorded.has(p)) : null;
}

// ── Map unmapped keywords ───────────────────────────────────────────────────
export type ServiceChoice = { id: string; name: string; group: TargetGroup | null };
export function mapRows(a: {
  report: ReportKeyword[];
  current: Map<string, CurrentKeyword>;
  services: ServiceChoice[];                    // approved services, by name
  marketKeys: Map<string, string>;              // normalised place → confirm_market key in the latest report
  normPlace: (s: string) => string;
}): ReconcileRow[] {
  const options: MapOption[] = a.services.map((s) => {
    const ok = !!s.group && s.group.live;
    return { service_id: s.id, name: s.name, destination_url: ok ? s.group!.target_url : null, enabled: ok,
      reason: ok ? null : `${s.name} has no live page yet` };
  });
  return a.report.filter((k) => k.role === "unmapped").map((k) => {
    const cur = a.current.get(k.keyword_id);
    const off = (reason: string, links: RowLink[] = []): ReconcileRow =>
      ({ id: k.keyword_id, label: k.keyword, enabled: false, reason, changes: [], links, payload: null, expected: null });
    if (!cur) return off("The keyword is gone; refresh the analysis.");
    if (cur.service_id) return off("It already has a service; refresh the analysis.");
    if (k.flags.includes("location_unapproved")) {
      const places = k.unapproved_places ?? [];
      const links = places.flatMap((p) => {
        const key = a.marketKeys.get(a.normPlace(p));
        return key ? [{ key, label: `Market: ${p}` }] : [];
      });
      const named = places.length ? ` (${places.join(", ")})` : "";
      return off(`${MARKET_FIRST}${named}`, links);
    }
    return {
      id: k.keyword_id, label: k.keyword, enabled: options.some((o) => o.enabled),
      reason: options.some((o) => o.enabled) ? null : "No approved service has a live page to map it to.",
      changes: [], links: [], options,
      payload: { keyword_id: k.keyword_id },
      expected: { keyword_id: k.keyword_id, service_id: cur.service_id, target_url: cur.target_url },
    };
  });
}
// The changes a mapped row makes, once a service is chosen.
export function mapChanges(row: ReconcileRow, option: MapOption | undefined): Change[] {
  if (!option?.enabled) return [];
  return [
    { record: `keywords · ${row.label}`, field: "service_id", before: "— (unmapped)", after: option.name },
    { record: `keywords · ${row.label}`, field: "target_url", before: show(row.expected?.target_url as string | null), after: option.destination_url! },
  ];
}

// ── What the client sends back: exactly the previewed rows ──────────────────
export type Selection = { id: string; service_id?: string }[];
export type ApplyBody = { payload: Record<string, unknown>; expected: Record<string, unknown> };

// Builds authority_apply's payload and expected from the preview and the
// ticked rows. Refuses anything the preview did not offer.
export function buildApply(action: ReconcileAction, base: Record<string, unknown>, rows: ReconcileRow[], selection: Selection): ApplyBody | { error: string } {
  if (action === "set_service_page") {
    const r = rows[0];
    if (!r?.enabled || !r.expected) return { error: "Nothing to apply." };
    return { payload: {}, expected: { ...base, ...r.expected } };
  }
  if (!selection.length) return { error: "Tick at least one row." };
  if (selection.length > MAX_SELECTED) return { error: `Select at most ${MAX_SELECTED} rows at a time.` };
  if (new Set(selection.map((s) => s.id)).size !== selection.length) return { error: "A row is selected twice." };
  const byId = new Map(rows.map((r) => [r.id, r]));
  const picked: { row: ReconcileRow; s: Selection[number] }[] = [];
  for (const s of selection) {
    const row = byId.get(s.id);
    if (!row || !row.enabled) return { error: "A selected row is not available; review again." };
    picked.push({ row, s });
  }
  if (action === "record_content") return { payload: { paths: picked.map((p) => p.row.id) }, expected: base };
  if (action === "rehome_keywords") {
    return { payload: { rows: picked.map((p) => p.row.payload) }, expected: { ...base, rows: picked.map((p) => p.row.expected) } };
  }
  const out: ApplyBody = { payload: { rows: [] }, expected: { ...base, rows: [] } };
  for (const { row, s } of picked) {
    const opt = row.options?.find((o) => o.service_id === s.service_id);
    if (!opt?.enabled) return { error: `Choose a service with a live page for "${row.label}".` };
    (out.payload.rows as unknown[]).push({ keyword_id: row.id, service_id: opt.service_id });
    (out.expected.rows as unknown[]).push({ ...row.expected, destination_url: opt.destination_url });
  }
  return out;
}

// ── authority_apply's answer ────────────────────────────────────────────────
export type ApplyAnswer = { rows?: unknown[]; skipped?: unknown[]; canonical_change?: boolean };
export type Outcome = { tone: "success" | "partial" | "info"; text: string; skipped: string[] };

export function resultText(action: ReconcileAction, r: ApplyAnswer, ctx: { service?: string } = {}): Outcome {
  const rows = (r.rows ?? []) as Record<string, unknown>[];
  const skipped = ((r.skipped ?? []) as unknown[]).map(String);
  switch (action) {
    case "set_service_page":
      return { tone: "success", text: `Service page set for ${ctx.service ?? "the service"}.`, skipped };
    case "rehome_keywords": {
      const home = rows.filter((x) => x.destination === "home").length;
      const svc = rows.length - home;
      const parts = [home && `${home} to Home`, svc && `${svc} to ${ctx.service ?? "the service"}'s page`].filter(Boolean);
      return { tone: "success", text: `Re-homed ${rows.length} keyword${rows.length === 1 ? "" : "s"}: ${parts.join(", ")}.`, skipped };
    }
    case "map_keywords":
      return { tone: "success", text: `Mapped ${rows.length} keyword${rows.length === 1 ? "" : "s"}: ${rows.map((x) => `${x.keyword} → ${(x.after as { service?: string })?.service ?? "?"}`).join("; ")}.`, skipped };
    case "record_content": {
      if (!rows.length) return { tone: "info", text: `Nothing recorded: ${skipped.length === 1 ? "the selected page was" : `all ${skipped.length} selected pages were`} already recorded.`, skipped };
      const text = `Recorded ${rows.length} page${rows.length === 1 ? "" : "s"} from the client's site (${NOT_COMPASS})`;
      return skipped.length
        ? { tone: "partial", text: `${text} ${skipped.length} already recorded: ${skipped.join(", ")}.`, skipped }
        : { tone: "success", text, skipped };
    }
  }
}

// ── The record-content card while pages remain (the partial state) ──────────
export type RecordProgress = { total: number; remaining: number; label: string; title: string } | null;
// While the latest analysis still reports the opportunity it is not done,
// whatever the linked rows say: Authority confirms completion by no longer
// reporting it.
export function recordProgress(a: { candidates: string[] | undefined; recorded: Set<string>; linked: number }): RecordProgress {
  const rem = remainingPaths(a.candidates, a.recorded);
  if (!rem || a.linked === 0) return null;
  if (rem.length > 0) {
    return { total: a.linked + rem.length, remaining: rem.length, label: `Partly recorded · ${rem.length} remaining`,
      title: `${a.linked} page${a.linked === 1 ? "" : "s"} recorded; ${rem.length} still to record.` };
  }
  return { total: a.linked, remaining: 0, label: "Recorded · awaiting refresh",
    title: "Every listed page is recorded; the next analysis confirms it." };
}
