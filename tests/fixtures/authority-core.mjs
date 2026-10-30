// An authority.core scope (authority_core_scope(), migration 20261030190000)
// for the engine's fictional and trimmed fixtures: one program whose approved
// Core 50 is the given keywords. By default every active keyword of an
// approved service, each with a usable owner (its target page) and no place
// problem, so the pre-P1.3 fixtures keep testing what they tested. Options
// shape the refusals the real function reports.
export const CORE_LIST = "c0re0000-0000-4000-8000-000000000002";

export function approvedCore(input, opts = {}) {
  const { listId = CORE_LIST, version = 2, include = null, exclude = [], children = {}, purposes = {}, geography = {},
    status = "approved", proposal = null, exempt = false } = opts;
  const approved = new Set(input.services.filter((s) => s.status === "approved").map((s) => s.id));
  const active = input.keywords.filter((k) => k.is_active !== false);
  const ids = (include ?? active.filter((k) => approved.has(k.service_id)).map((k) => k.id)).filter((id) => !exclude.includes(id)).sort();
  const entry = (k, relation, parent) => ({
    keyword_id: k.id, keyword: k.keyword, program_id: null, relation, list_id: listId, list_version: version, core_keyword_id: parent,
    service_id: k.service_id ?? null, intent: k.intent ?? null,
    owner: { url: k.target_url ?? null, role: "service", market_id: null, market: null, problem_code: purposes[k.id]?.post ?? null, problem: purposes[k.id]?.post ? `fixture: ${purposes[k.id].post}` : null },
    purposes: { post: null, blog: null, refresh: null, ...(purposes[k.id] ?? {}) },
    geography: geography[k.id] ?? "none", places: [], structured_city: null,
  });
  const keywords = status !== "approved" ? [] : [
    ...ids.map((id) => active.find((k) => k.id === id)).filter(Boolean).map((k) => entry(k, "core", k.id)),
    ...Object.entries(children).filter(([, parent]) => ids.includes(parent))
      .map(([id, parent]) => active.find((k) => k.id === id) && entry(active.find((k) => k.id === id), "child", parent)).filter(Boolean),
  ];
  return {
    schema: "authority-core-v1", client_id: input.client.id, multi: false, exempt,
    reference: { ok: true, problem: null },
    programs: [{ program_id: null, name: input.client.name, website_url: input.client.website_url ?? null, service_ids: null,
      status, list: status === "approved" ? { id: listId, version, approved_at: "2026-10-29T18:00:00Z", keyword_ids: ids } : null, proposal }],
    keywords, active_keywords: active.length, off_list: active.length - keywords.length,
  };
}

// Attach a default scope after a test's mutation, unless the test set one.
export function withCore(input, before) {
  if (input.authority.core === before) input.authority.core = approvedCore(input);
  return input;
}
