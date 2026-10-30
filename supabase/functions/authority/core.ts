// Core 50 scope (P1.3, migration 20261030190000): which keywords may become
// content opportunities. Pure: reads authority.core (authority_core_scope(),
// loaded by authority_input_scoped()) and decides per keyword, service and
// purpose. Nothing here falls back: no scope, no approved list for the
// service's site, a keyword the approved list does not ground, an owner the
// resolver refuses or a place named without a market of the site is a
// refusal with its code, never the full keyword inventory.
//
//   grounded   the program's approved list names the keyword, or names its
//              active core parent (a supporting child) — core_keyword_grounding().
//   owner      keyword_owner() for the purpose (post / blog / refresh); add
//              (a page that does not exist yet) tolerates only the page's
//              own absence.
//   geography  places the keyword's text names: structured or none passes;
//              text_only, without_market, mismatch and unassessed refuse
//              (site_program_readiness() reads them the same way).
//
// An exempt client (Tom's recorded core keyword exemption) passes, labelled
// "exempt": the database's own core gates skip it too.
import type { AuthorityInput, Reason } from "./types.ts";

export const CORE_SCHEMA = "authority-core-v1";
export type CorePurpose = "post" | "blog" | "refresh" | "add";
export type Geography = "structured" | "none" | "text_only" | "without_market" | "mismatch" | "unassessed";

export type CoreProgram = {
  program_id: string | null; name: string; website_url: string | null; service_ids: string[] | null;
  status: "approved" | "proposed_only" | "missing";
  list: { id: string; version: number; approved_at: string; keyword_ids: string[] } | null;
  proposal: { id: string; version: number; proposed_at: string; count: number } | null;
};
export type CoreKeyword = {
  keyword_id: string; keyword: string; program_id: string | null; relation: "core" | "child";
  list_id: string; list_version: number; core_keyword_id: string; service_id: string | null; intent: string | null;
  owner: { url: string | null; role: string | null; market_id: string | null; market: string | null; problem_code: string | null; problem: string | null };
  purposes: { post: string | null; blog: string | null; refresh: string | null };
  geography: Geography; places: { place: string; state: string; basis: string; market: boolean }[]; structured_city: string | null;
};
export type CoreScope = {
  schema: typeof CORE_SCHEMA; client_id: string; multi: boolean; exempt: boolean;
  reference: { ok: boolean; problem: string | null };
  programs: CoreProgram[]; keywords: CoreKeyword[]; active_keywords: number; off_list: number;
};

// The run receipt each keyword-targeted opportunity carries.
export type CoreReceipt = {
  schema: typeof CORE_SCHEMA; purpose: CorePurpose; program_id: string | null; program: string | null;
  list_id: string | null; list_version: number | null; keyword_id: string | null;
  relation: "core" | "child" | "exempt" | null; core_keyword_id: string | null;
  owner_url: string | null; owner_role: string | null; market_id: string | null; geography: Geography | null;
  verdict: string | null; detail: string | null;
};
export type CoreVerdict = { ok: boolean; receipt: CoreReceipt };

// A page that does not exist yet is what a service_page "create" builds.
const ADD_TOLERATES = new Set(["target_page_missing", "page_not_verified"]);
const GEO_REFUSES: Record<string, string> = {
  text_only: "names an approved market only in its text; link the keyword to that market first",
  without_market: "names a place that is not an approved market of this site",
  mismatch: "names a place other than its structured market",
  unassessed: "could not be checked against the place reference (place-names-v1 is not loaded exactly)",
};

// The scope, only when it is this schema and this client's.
export const coreScopeOf = (input: AuthorityInput): CoreScope | null => {
  const c = (input.authority as { core?: CoreScope | null }).core ?? null;
  return c && c.schema === CORE_SCHEMA && c.client_id === input.client.id ? c : null;
};

// The site program a service belongs to: its brand site for a multi-brand
// client (exactly one), else the client's single program.
export function programOfService(scope: CoreScope, serviceId: string | null): CoreProgram | null {
  if (!scope.multi) return scope.programs[0] ?? null;
  if (!serviceId) return null;
  const hits = scope.programs.filter((p) => (p.service_ids ?? []).includes(serviceId));
  return hits.length === 1 ? hits[0] : null;
}

export function coreVerdict(input: AuthorityInput, keywordId: string | null, serviceId: string | null, purpose: CorePurpose): CoreVerdict {
  const scope = coreScopeOf(input);
  const receipt: CoreReceipt = {
    schema: CORE_SCHEMA, purpose, program_id: null, program: null, list_id: null, list_version: null, keyword_id: keywordId,
    relation: null, core_keyword_id: null, owner_url: null, owner_role: null, market_id: null, geography: null, verdict: null, detail: null,
  };
  const no = (verdict: string, detail: string): CoreVerdict => ({ ok: false, receipt: { ...receipt, verdict, detail } });
  if (!scope) return no("core_scope_missing", "The run has no Core 50 scope for this client; nothing is actionable until it is loaded.");
  const prog = programOfService(scope, serviceId);
  if (!prog) return no("program_unresolved", "The service belongs to no single site program.");
  Object.assign(receipt, { program_id: prog.program_id, program: prog.name, list_id: prog.list?.id ?? null, list_version: prog.list?.version ?? null });
  if (scope.exempt) return { ok: true, receipt: { ...receipt, relation: "exempt", detail: "Tom's recorded core keyword exemption; the per-draft core gates skip this client too." } };
  if (prog.status !== "approved" || !prog.list) {
    return no(prog.status === "proposed_only" ? "core_list_not_approved" : "core_list_missing",
      prog.proposal ? `${prog.name}'s Core 50 is a proposal (v${prog.proposal.version}, ${prog.proposal.count} keywords); nothing is used until it is approved.`
        : `${prog.name} has no Core 50 list.`);
  }
  if (!keywordId) return no("keyword_missing", "No keyword is targeted.");
  const k = scope.keywords.find((x) => x.keyword_id === keywordId);
  if (!k) return no("keyword_not_core", `Not in ${prog.name}'s approved Core 50 v${prog.list.version}, and no core parent in it.`);
  Object.assign(receipt, {
    relation: k.relation, core_keyword_id: k.core_keyword_id, owner_url: k.owner.url, owner_role: k.owner.role,
    market_id: k.owner.market_id, geography: k.geography,
  });
  if (k.program_id !== prog.program_id || k.list_id !== prog.list.id) return no("keyword_wrong_program", "The keyword is grounded by another site program's list.");
  if (serviceId && k.service_id && k.service_id !== serviceId) return no("keyword_wrong_service", "The keyword's related service is another service.");
  const code = purpose === "add"
    ? (k.intent === null ? "intent_missing" : k.owner.problem_code && !ADD_TOLERATES.has(k.owner.problem_code) ? k.owner.problem_code : null)
    : k.purposes[purpose];
  if (code) return no(code, k.owner.problem_code === code ? k.owner.problem ?? code : code === "intent_missing" ? "The keyword has no recorded intent." : `The owner page may not anchor a ${purpose}.`);
  if (GEO_REFUSES[k.geography]) {
    const places = k.places.map((p) => `${p.place}, ${p.state}${p.market ? " (market)" : ""}`).join("; ");
    return no(`place_${k.geography}`.replace("place_unassessed", "geography_unassessed"), `"${k.keyword}" ${GEO_REFUSES[k.geography]}${places ? ` [${places}]` : ""}.`);
  }
  return { ok: true, receipt };
}

export const coreReason = (v: CoreVerdict): Reason => v.ok
  ? { tag: "FACT", text: v.receipt.relation === "exempt" ? v.receipt.detail! : `In ${v.receipt.program}'s approved Core 50 v${v.receipt.list_version}${v.receipt.relation === "child" ? " through its core parent" : ""}; owner ${v.receipt.owner_url ?? "–"}.` }
  : { tag: "FACT", text: `Core 50: ${v.receipt.verdict} — ${v.receipt.detail}` };

// The report's summary: what each program's discovery was limited to.
export type CoreSummary = {
  schema: typeof CORE_SCHEMA; loaded: boolean; exempt: boolean; reference_ok: boolean | null;
  programs: { program_id: string | null; name: string; status: CoreProgram["status"] | "unknown"; list_id: string | null; list_version: number | null;
    keyword_ids: string[]; proposal: CoreProgram["proposal"]; grounded: number; children: number }[];
  active_keywords: number | null; off_list: number | null; refused: Record<string, number>;
};
export function coreSummary(input: AuthorityInput, refused: string[]): CoreSummary {
  const scope = coreScopeOf(input);
  const count: Record<string, number> = {};
  for (const r of refused) count[r] = (count[r] ?? 0) + 1;
  return {
    schema: CORE_SCHEMA, loaded: !!scope, exempt: scope?.exempt ?? false, reference_ok: scope ? scope.reference.ok : null,
    programs: (scope?.programs ?? []).map((p) => ({
      program_id: p.program_id, name: p.name, status: p.status, list_id: p.list?.id ?? null, list_version: p.list?.version ?? null,
      keyword_ids: p.list?.keyword_ids ?? [], proposal: p.proposal,
      grounded: scope!.keywords.filter((k) => k.program_id === p.program_id && k.relation === "core").length,
      children: scope!.keywords.filter((k) => k.program_id === p.program_id && k.relation === "child").length,
    })),
    active_keywords: scope?.active_keywords ?? null, off_list: scope?.off_list ?? null,
    refused: Object.fromEntries(Object.entries(count).sort(([a], [b]) => a.localeCompare(b))),
  };
}

// Where the approved Core 50 puts one keyword, for the report's keyword table.
export function keywordCore(input: AuthorityInput, keywordId: string): NonNullable<import("./types.ts").KeywordAssignment["core"]> {
  const scope = coreScopeOf(input);
  if (!scope) return { status: "not_loaded", program_id: null, list_version: null, core_keyword_id: null, post: null };
  const k = scope.keywords.find((x) => x.keyword_id === keywordId);
  if (k) {
    const post = k.purposes.post ?? (GEO_REFUSES[k.geography] ? (k.geography === "unassessed" ? "geography_unassessed" : `place_${k.geography}`) : null);
    return { status: k.relation, program_id: k.program_id, list_version: k.list_version, core_keyword_id: k.core_keyword_id, post };
  }
  if (scope.exempt) return { status: "exempt", program_id: null, list_version: null, core_keyword_id: null, post: null };
  const status = scope.programs.some((p) => p.status === "approved") ? "off_list" : "no_approved_list";
  return { status, program_id: null, list_version: null, core_keyword_id: null, post: status };
}

// Grounding only (scope, program, approved list, membership): what a
// campaign cluster may contain. Owner and place verdicts stay per purpose.
const GROUNDING = new Set(["core_scope_missing", "program_unresolved", "core_list_not_approved", "core_list_missing", "keyword_missing", "keyword_not_core", "keyword_wrong_program", "keyword_wrong_service"]);
export const groundingProblem = (v: CoreVerdict): string | null => (!v.ok && GROUNDING.has(v.receipt.verdict!) ? v.receipt.verdict : null);
