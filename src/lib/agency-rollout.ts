import type { OperationsV2 } from './operations-readiness';
import { alertScope } from './operations-overview.ts';

export const ROLLOUT_STANDARD = '1.0';
export const STAGES = ['unassessed', 'scoped', 'configured', 'ready', 'pilot', 'operating'] as const;
export type RolloutStage = typeof STAGES[number];
export const STAGE_LABELS: Record<RolloutStage, string> = {
  unassessed: 'Not assessed', scoped: 'Scoped', configured: 'Configured', ready: 'Ready for pilot',
  pilot: 'Pilot verified', operating: 'Operating',
};
// Explicit scope is reviewed per client/brand. No contract inferred from setup.
export const REQUIREMENTS = [
  { key: 'intelligence', layer: 1, label: 'Approved facts, keywords and owner pages' },
  { key: 'gsc', layer: 2, label: 'Search Console reporting' },
  { key: 'ga4', layer: 2, label: 'Analytics reporting' },
  { key: 'gbp', layer: 2, label: 'Business Profile reporting' },
  { key: 'rankings', layer: 2, label: 'Keyword rankings and baseline' },
  { key: 'backlinks', layer: 2, label: 'Backlink evidence' },
  { key: 'engine', layer: 3, label: 'Governed Authority and drafting' },
  { key: 'workflow', layer: 4, label: 'Agreed cadence, review owner and exception handling' },
  { key: 'website', layer: 5, label: 'Website delivery and live URL proof' },
  { key: 'blogs', layer: 5, label: 'Blog publication and measurement' },
  { key: 'facebook', layer: 5, label: 'Facebook publication and measurement' },
  { key: 'instagram', layer: 5, label: 'Instagram publication and measurement' },
  { key: 'gbp_publish', layer: 5, label: 'Business Profile publication and measurement' },
] as const;
export type RequirementKey = typeof REQUIREMENTS[number]['key'];
export type Applicability = 'unknown' | 'required' | 'optional' | 'excluded';
export type RolloutHealth = 'current' | 'attention' | 'blocked' | 'unknown';
export type RequirementReview = {
  key: RequirementKey; applicability: Applicability; state: RolloutHealth;
  evidence_ref: string; checked_at: string; valid_until: string;
  period: string; reason: string; review_trigger: string; owner: string; next_action: string;
};
export type RolloutReview = {
  id: string; client_id: string; brand_workspace_id: string | null; version: number;
  standard_version: string; stage: RolloutStage; requirements: RequirementReview[];
  scope_ref: string; configuration_ref: string; pilot_ref: string;
  cycle_one_start: string | null; cycle_one_ref: string;
  cycle_two_start: string | null; cycle_two_ref: string;
  owner: string; next_action: string; reason: string;
  critical_clear: boolean; accepted: boolean; reviewed_by: string; reviewed_at: string;
};
export type RolloutWrite = Omit<RolloutReview, 'id' | 'reviewed_by' | 'reviewed_at'>;
export type RolloutBrand = { id: string; client_id: string; name: string; ga4_property: string | null; gsc_property: string | null };
export const blankRequirements = (): RequirementReview[] => REQUIREMENTS.map(({key}) => ({
  key, applicability: 'unknown', state: 'unknown', evidence_ref: '', checked_at: '', valid_until: '',
  period: '', reason: '', review_trigger: '', owner: '', next_action: '',
}));
export function reviewHealth(review: RolloutReview | null, now: string): RolloutHealth {
  if (!review || review.standard_version !== ROLLOUT_STANDARD) return 'unknown';
  const required = review.requirements.filter(r => r.applicability === 'required');
  if (required.some(r => r.state === 'blocked')) return 'blocked';
  if (!required.length || review.requirements.some(r => r.applicability === 'unknown')) return 'unknown';
  if (required.some(r => r.state === 'unknown' || !r.evidence_ref || !Number.isFinite(Date.parse(r.checked_at)) ||
    Date.parse(r.checked_at) > Date.parse(now) || !Number.isFinite(Date.parse(r.valid_until)))) return 'unknown';
  if (required.some(r => r.state === 'attention' || Date.parse(r.valid_until) < Date.parse(now))) return 'attention';
  return 'current';
}
export function latestReview(rows: RolloutReview[], clientId: string, brandId: string | null) {
  return rows.filter(r => r.client_id === clientId && r.brand_workspace_id === brandId)
    .toSorted((a,b) => b.version-a.version)[0] ?? null;
}
const healthOrder: RolloutHealth[] = ['current','attention','unknown','blocked'];
const worst = (states: RolloutHealth[]) => states.toSorted((a,b) => healthOrder.indexOf(b)-healthOrder.indexOf(a))[0] ?? 'unknown';

export function buildRolloutScorecard(data: OperationsV2, rows: RolloutReview[] | null, brands: RolloutBrand[] | null) {
  return data.clients.map(client => {
    const ownBrands = brands?.filter(b => b.client_id === client.id) ?? [];
    const scopes = [{ id: null as string | null, name: ownBrands.length ? 'Parent / shared services' : 'Client', brand: null as RolloutBrand | null },
      ...ownBrands.map(b => ({ id:b.id, name:b.name, brand:b }))].map(scope => {
      const review = rows && latestReview(rows,client.id,scope.id);
      const required = review?.requirements.filter(r => r.applicability === 'required') ?? [];
      const states: RolloutHealth[] = [reviewHealth(review, data.generatedAt)];
      // Read failures cannot become healthy because a manual review was green.
      if (rows === null || brands === null || data.sourceErrors.length) states.push('unknown');
      for (const key of ['gsc','ga4','gbp'] as const) {
        if (!required.some(r => r.key === key)) continue;
        const integration = data.integrations.find(e => e.clientId === client.id && e.source === key);
        // Shared GBP is never automatically attributed to a child brand.
        const property = scope.brand?.[key === 'gsc' ? 'gsc_property' : 'ga4_property'];
        const matches = integration?.scopes.filter(s => s.property === property) ?? [];
        const state = scope.brand ? (key === 'gbp' || !property || matches.length !== 1 ? 'unknown' : matches[0].health ?? 'unknown') : integration?.state;
        states.push(state === 'verified' ? 'current' : state === 'failed' ? 'blocked' :
          !state || state === 'unknown' ? 'unknown' : 'attention');
      }
      // Client-wide unresolved release exceptions also affect its brands until
      // independently reconciled. Supporting-system holds do not enter marketing health.
      const critical = data.alerts.filter(a => a.clientId === client.id && a.severity === 'critical' &&
        alertScope(a) !== 'support' && (alertScope(a) === 5 || alertScope(a) === 'unclassified'));
      if (critical.length) states.push('blocked');
      return { ...scope, review, stage: review?.stage ?? 'unassessed' as RolloutStage, health: worst(states),
        required: required.length, verified: required.filter(r => reviewHealth({...review!,requirements:[r]},data.generatedAt) === 'current').length,
        critical, history: rows?.filter(r => r.client_id === client.id && r.brand_workspace_id === scope.id).toSorted((a,b)=>b.version-a.version) ?? [] };
    });
    const stage = brands === null || rows === null ? 'unassessed' : scopes.toSorted((a,b)=>STAGES.indexOf(a.stage)-STAGES.indexOf(b.stage))[0].stage;
    return { id:client.id, name:client.name, scopes, stage, health:worst(scopes.map(s=>s.health)) };
  });
}

export function validateRolloutWrite(value: RolloutWrite, previous: RolloutReview | null, now: string): string | null {
  if (value.standard_version !== ROLLOUT_STANDARD || !STAGES.includes(value.stage)) return 'Unsupported operating standard or stage.';
  if (value.version !== (previous?.version ?? 0)+1) return 'This review changed. Reload before saving.';
  if (!value.reason.trim() || !value.owner.trim() || !value.next_action.trim()) return 'Record an owner, next action and review reason.';
  if (value.requirements.length !== REQUIREMENTS.length || new Set(value.requirements.map(r=>r.key)).size !== REQUIREMENTS.length ||
    REQUIREMENTS.some(r=>!value.requirements.some(v=>v.key===r.key))) return 'Review every requirement exactly once.';
  for (const r of value.requirements) {
    if (!['unknown','required','optional','excluded'].includes(r.applicability) || !healthOrder.includes(r.state)) return 'Invalid scope or evidence state.';
    if (Object.values(r).some(s=>typeof s !== 'string' || s.length > 2000)) return 'Requirement fields must be text of at most 2,000 characters.';
    if (['optional','excluded'].includes(r.applicability) && (!r.reason.trim() || !r.evidence_ref.trim() || !r.review_trigger.trim())) return 'Optional and excluded requirements need a reason, decision reference and review trigger.';
    if (r.applicability === 'required' && (!r.owner.trim() || !r.next_action.trim())) return 'Every required item needs an owner and next action.';
    if (r.state === 'current' && (!r.evidence_ref.trim() || !Number.isFinite(Date.parse(r.checked_at)) || !Number.isFinite(Date.parse(r.valid_until)) ||
      Date.parse(r.checked_at)>Date.parse(now) || Date.parse(r.valid_until)<Date.parse(r.checked_at))) return 'Current evidence needs its reference, a past check time and a valid review expiry.';
  }
  const rank=STAGES.indexOf(value.stage), prior=STAGES.indexOf(previous?.stage ?? 'unassessed');
  const scopeChanged=previous && (value.scope_ref!==previous.scope_ref || value.requirements.some(r=>
    r.applicability!==previous.requirements.find(p=>p.key===r.key)?.applicability));
  if (scopeChanged && prior>=3 && rank>=3) return 'Scope changed. Return to Configured or earlier and verify the new scope before advancing.';
  if (rank>prior+1) return 'Advance one stage at a time and retain the evidence for each gate.';
  if (rank>=1 && (!value.scope_ref.trim() || value.requirements.some(r=>r.applicability==='unknown') || !value.requirements.some(r=>r.applicability==='required'))) return 'Scoped requires agreed scope, every applicability decision, and at least one required service.';
  if (rank>=2 && !value.configuration_ref.trim()) return 'Configured requires a configuration evidence reference.';
  // Existing accepted stages survive later incidents. Re-entering a higher
  // stage requires fresh proof, including a new Operating acceptance.
  if (rank>prior && rank>=3 && (reviewHealth({...value,id:'',reviewed_by:'',reviewed_at:now},now)!=='current' || !value.critical_clear)) return 'Before advancing, verify every required item and confirm there are no unresolved critical marketing incidents.';
  if (rank>=4 && !value.pilot_ref.trim()) return 'Pilot verification needs the full cycle receipt and measurement reference.';
  if (rank>=5) {
    const first=Date.parse(value.cycle_one_start ?? ''), second=Date.parse(value.cycle_two_start ?? '');
    if (!Number.isFinite(first) || !Number.isFinite(second) || second-first!==7*86400000 || second+7*86400000>Date.parse(now) ||
      !value.cycle_one_ref.trim() || !value.cycle_two_ref.trim() || !value.accepted) return 'Operating requires two consecutive completed seven-day delivery cycles, their evidence, and explicit acceptance.';
  }
  return null;
}
