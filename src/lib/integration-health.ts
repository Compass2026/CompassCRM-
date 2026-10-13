// Read-only projection of validated import receipts and provider outcomes.
// Scheduler completion and a configured property never establish provider health.
export type IntegrationSource = "gsc" | "ga4" | "gbp";
export type IntegrationState = "verified" | "failed" | "partial" | "missing" | "stale" | "unknown" | "running" | "unconfigured";
export type IntegrationRun = { id: string; client_id?: string; created_at: string; finished_at: string | null; status: string; results: unknown };
export type ImportReceipt = { id: string; client_id: string; property?: string; account_id?: string; location_id?: string; period: string; period_end: string; created_at: string };
export type IntegrationBinding = { clientId: string; label: string; property: string; accountId?: string };
export type IntegrationEvidence = {
  clientId: string; source: IntegrationSource; state: IntegrationState;
  configured: boolean | null; lastAttempt: string | null; attemptResult: string;
  lastSuccess: string | null; lastImported: string | null; windowEnd: string | null;
  evidence: string; nextAction: string; href: string;
  scopes: { label: string; property: string; windowEnd: string | null; state: "current" | "stale" | "missing" | "unknown" }[];
};
export type IntegrationInputs = {
  bindings: Record<IntegrationSource, IntegrationBinding[] | null>;
  imports: Record<IntegrationSource, ImportReceipt[] | null>;
  runs: Record<IntegrationSource, IntegrationRun[] | null>;
};
export const SOURCE_POLICY = {
  gsc: { label: "Search Console", windowDays: 45, retrievalHours: 48, cadence: "Complete months; 45-day window, daily retrieval" },
  ga4: { label: "Analytics 4", windowDays: 7, retrievalHours: 48, cadence: "Month-to-date with 4-day provider delay; 7-day window, daily retrieval" },
  gbp: { label: "Business Profile / Zernio", windowDays: 45, retrievalHours: 48, cadence: "Complete months; 45-day window, daily retrieval" },
} as const;
const time = (s: string | null | undefined) => s && Number.isFinite(Date.parse(s)) ? Date.parse(s) : NaN;
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const safeCode = (v: unknown) => typeof v === "string" && /^(google_http_\d{3}|provider_http_\d{3}|google_token_failed|property_access_missing|property_binding_mismatch|timezone_mismatch|incomplete_report|invalid_website|no_reported_data|unexpected_dimensions|invalid_metrics|import_write_failed|import_failed|binding_incomplete|location_changed|response_identity_mismatch|incomplete_metric_days|invalid_metric_day|metric_total_mismatch|aggregation_mismatch)$/.test(v) ? v : "provider_result_unverified";
const validAt = (s: string | null | undefined, now: number) => Number.isFinite(time(s)) && time(s) <= now;

export function integrationEvidence(input: IntegrationInputs, clientId: string, source: IntegrationSource, now: string): IntegrationEvidence {
  const clock = time(now), policy = SOURCE_POLICY[source];
  const bindings = input.bindings[source]?.filter(b => b.clientId === clientId) ?? [];
  const receipts = input.imports[source]?.filter(r => r.client_id === clientId && bindings.some(b =>
    source === "gbp" ? r.location_id === b.property && r.account_id === b.accountId : r.property === b.property)) ?? [];
  const usable = receipts.filter(r => validAt(r.created_at, clock) && validAt(r.period_end, clock));
  const scopes: IntegrationEvidence["scopes"] = bindings.map(b => {
    const scoped = usable.filter(r => source === "gbp" ? r.location_id === b.property && r.account_id === b.accountId : r.property === b.property);
    const latest = scoped.toSorted((a,b) => time(b.period_end)-time(a.period_end))[0];
    return {label:b.label, property:b.property, windowEnd:latest?.period_end ?? null,
      state:input.imports[source] === null ? "unknown" : !latest ? "missing" :
        clock-time(latest.period_end) > policy.windowDays*86400000 ? "stale" : "current"};
  });
  const runs = (input.runs[source] ?? []).map(r => ({...r, outcomes: Array.isArray(r.results) ? r.results.map(object).filter(o =>
    source === "gbp" ? o.client_id === clientId : o.client_id === undefined || o.client_id === clientId) : []}))
    .filter(r => source === "gbp" ? r.outcomes.length > 0 : r.client_id === clientId)
    .toSorted((a,b) => time(b.created_at)-time(a.created_at));
  const latest = runs[0];
  // Existing Google logs omit property/brand identity. Never assign a parent
  // run to one of several websites. Immutable receipts remain scoped exactly.
  const ambiguous = new Set(bindings.map(b => b.property)).size > 1;
  const confirmed = (r: typeof runs[number]) => !ambiguous && validAt(r.finished_at,clock) && time(r.finished_at) >= time(r.created_at) && r.outcomes.some(o =>
    (o.status === "imported" && usable.some(x => x.id === o.receipt_id)) ||
    (o.status === "unchanged" && usable.some(x => x.period === o.month && time(x.created_at) <= time(r.finished_at))));
  const success = runs.filter(confirmed).toSorted((a,b) => time(b.finished_at)-time(a.finished_at))[0];
  const imported = usable.toSorted((a,b) => time(b.created_at)-time(a.created_at))[0];
  const windowEnd = usable.toSorted((a,b) => time(b.period_end)-time(a.period_end))[0]?.period_end ?? null;
  const base: IntegrationEvidence = {
    clientId,source,state:"unknown",configured:input.bindings[source] === null ? null : bindings.some(b=>!!b.property),
    lastAttempt:latest && validAt(latest.created_at,clock) ? latest.created_at : null,
    attemptResult:"No client-scoped attempt recorded",lastSuccess:success?.finished_at ?? null,
    lastImported:imported?.created_at ?? null,windowEnd,scopes,
    evidence:"",nextAction:"Review connection and source evidence.",href:`/clients/${clientId}/growth`,
  };
  const finish = (state: IntegrationState,evidence:string,nextAction:string): IntegrationEvidence => ({...base,state,evidence,nextAction});
  if (!Number.isFinite(clock) || [input.bindings[source],input.imports[source],input.runs[source]].some(x=>x===null))
    return finish("unknown","Source evidence could not be read completely.","Reload the Control Center; investigate access or incomplete source reads if this persists.");
  if (!bindings.some(b=>!!b.property)) return finish("unconfigured","No reporting property or exact Zernio location binding recorded.",source === "gbp" ? "Open Social and verify the GBP reporting binding and account access." : "Open the client Overview and confirm the reporting property and website.");
  if (latest) {
    const failed=latest.outcomes.filter(o=>o.status === "failed" || o.status === "no_data");
    const good=latest.outcomes.filter(o=>o.status === "imported" || o.status === "unchanged");
    base.attemptResult=latest.status === "running" ? "Running" : !latest.outcomes.length ? "No provider results" :
      `${good.length} successful, ${failed.length} failed or empty result windows${ambiguous ? " (parent-client log; brand unattributed)" : ""}`;
    if (!validAt(latest.created_at,clock) || (latest.finished_at !== null && (!validAt(latest.finished_at,clock) || time(latest.finished_at)<time(latest.created_at))))
      return finish("unknown","Sync timestamps are invalid or in the future.","Inspect the sync record before trusting its result.");
    if (latest.status === "running") return finish(clock-time(latest.created_at)>600000 ? "failed" : "running",
      "Latest recorded sync has no completion receipt.","Review the importer run before requesting another read-only sync.");
    if (!validAt(latest.finished_at,clock)) return finish("unknown","Latest sync has no valid completion timestamp.","Inspect the importer run and completion logging.");
    if (failed.length) return finish(good.length ? "partial" : "failed",
      `${failed.length} result windows need review: ${[...new Set(failed.map(o=>safeCode(o.code)))].join(", ")}. ${ambiguous ? "The run does not identify a brand." : ""}`,
      failed.some(o=>/token|access|http_40[13]/.test(safeCode(o.code))) ? "Check provider authorization in Settings, then verify a successful retrieval." : "Review missing periods and provider results in the client reporting workflow.");
    if (!latest.outcomes.length || !good.length) return finish("missing","A completed job did not provide usable provider outcomes.","Check the reporting property, collection dates and importer results; an empty result is not zero traffic.");
    if (latest.outcomes.length !== good.length || !["completed","partial"].includes(latest.status))
      return finish("unknown","The latest provider result is not recognized.","Inspect the sync receipt before treating the source as verified.");
    if (latest.status === "partial") return finish("partial","The run is marked partial even though its recorded result windows succeeded.","Inspect the run for missing result windows.");
  }
  if (scopes.some(s=>s.state === "missing")) return finish("missing","At least one configured website has no validated import receipt.","Verify access and retrieve data for each configured website. Missing data is never zero.");
  if (scopes.some(s=>s.state === "stale")) return finish("stale","At least one website has an old reporting window.","Open reporting and verify the latest expected data period.");
  if (ambiguous) return finish("unknown","Receipts are separated by property; sync logs do not identify the brand that was attempted.","Review each brand below. Per-brand attempt tracking is needed before all-brand health can be verified.");
  if (!latest || !confirmed(latest)) return finish("unknown","No latest successful provider result can be matched to an import receipt.","Verify a provider retrieval with a matching receipt; older measurements alone do not prove current access.");
  if (!base.lastSuccess || clock-time(base.lastSuccess)>policy.retrievalHours*3600000)
    return finish("stale","No confirmed provider retrieval within 48 hours for this daily importer.","Check the daily importer and retrieve current source data.");
  return finish("verified","Latest provider result matches a validated import receipt and the reporting window is current.","Continue scheduled monitoring. This verifies recorded retrieval, not a live permission probe.");
}

// An API row cap can be lower than the requested limit. Require exact count
// equality; silently truncated evidence must never become healthy or zero.
export function completeRead<T>(query: { data: T[] | null; count: number | null; error: unknown }): T[] | null {
  return query.error || query.data === null || query.count === null || query.count !== query.data.length ? null : query.data;
}
