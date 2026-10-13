import type { Alert, ClientReadiness, OperationsV2, ReadinessCheck } from './operations-readiness';

export const FIVE_LAYERS = [
  { id: 1, title: 'Client Intelligence', purpose: 'Approved facts, brands, services, keywords and owner pages.' },
  { id: 2, title: 'Data & Intelligence', purpose: 'Provider evidence, rankings and reporting baselines.' },
  { id: 3, title: 'AI Engine', purpose: 'Current Authority analysis and governed draft requests.' },
  { id: 4, title: 'Work Management', purpose: 'Human reviews, approvals and backlink follow-ups.' },
  { id: 5, title: 'Execution & Measurement', purpose: 'Publishing destinations and unresolved release attempts.' },
] as const;
export type LayerId = typeof FIVE_LAYERS[number]['id'];
export type Scope = LayerId | 'support' | 'unclassified';
type EvidenceCounts = Record<ReadinessCheck['state'], number>;
export type OverviewAction = { clientId: string; clientName: string; title: string; detail: string; href: string };
export type LayerOverview = {
  id: Scope; title: string; purpose: string;
  checks: EvidenceCounts; total: number; alerts: number; critical: number;
  next: OverviewAction | null;
};

// Classify stable evidence keys, never prose or client names. Unknown future keys
// remain visible as unclassified rather than silently disappearing.
export function checkScope(key: string): Scope {
  if (['brand', 'keywords'].includes(key) || /^(services|claims|intent):/.test(key)) return 1;
  if (['search', 'analytics', 'gbp', 'baseline'].includes(key)) return 2;
  if (key === 'authority') return 3;
  if (['website', 'publishing'].includes(key) || /^(social-channel|destination):/.test(key)) return 5;
  if (['intake', 'billing', 'portal'].includes(key)) return 'support';
  return 'unclassified';
}
export function alertScope(alert: Alert): Scope {
  const key = alert.id.startsWith(alert.clientId + ':') ? alert.id.slice(alert.clientId.length + 1) : '';
  if (key === 'brands') return 1;
  if (/^(integration:|stale:)/.test(key) || ['ops:rankings', 'ops:backlinks'].includes(key)) return 2;
  if (key.startsWith('orphan:')) return 3;
  if (/^(review:|ops:social-review:)/.test(key) || ['ops:backlinks-due', 'ops:backlinks-research'].includes(key)) return 4;
  if (/^(release:|queued:|ops:social-delivery:)/.test(key) || ['site', 'ops:social', 'ops:websites', 'ops:backlinks-check'].includes(key)) return 5;
  if (['sms', 'ops:notifications', 'ops:billing', 'ops:billing-setup'].includes(key)) return 'support';
  return 'unclassified';
}
const severity = { critical: 0, attention: 1, setup: 2 };
const statePriority = { blocked: 0, unknown: 1, missing: 2, waiting: 3, recorded: 4 };

export function buildFiveLayerOverview(data: OperationsV2, clientIds?: readonly string[]) {
  const selected = clientIds ? new Set(clientIds) : null;
  const clients = data.clients.filter(c => !selected || selected.has(c.id));
  const knownClients = new Map(clients.map(c => [c.id, c]));
  const alerts = data.alerts.filter(a => knownClients.has(a.clientId));
  const scopes: { id: Scope; title: string; purpose: string }[] = [
    ...FIVE_LAYERS,
    { id: 'support', title: 'Supporting systems', purpose: 'CRM Lite, billing and client portal readiness.' },
    { id: 'unclassified', title: 'Other evidence', purpose: 'Evidence awaiting a layer assignment.' },
  ];
  const summaries: LayerOverview[] = scopes.map(scope => {
    const checks: EvidenceCounts = { recorded: 0, missing: 0, waiting: 0, blocked: 0, unknown: 0 };
    const requirements: { client: ClientReadiness; check: ReadinessCheck }[] = [];
    for (const client of clients) for (const check of client.readiness) {
      if (checkScope(check.key) !== scope.id) continue;
      checks[check.state]++;
      if (check.state !== 'recorded') requirements.push({ client, check });
    }
    const ownAlerts = alerts.filter(a => alertScope(a) === scope.id).toSorted((a,b) =>
      severity[a.severity] - severity[b.severity] || a.clientName.localeCompare(b.clientName) || a.id.localeCompare(b.id));
    requirements.sort((a,b) => statePriority[a.check.state] - statePriority[b.check.state] ||
      a.client.name.localeCompare(b.client.name) || a.check.key.localeCompare(b.check.key));
    const alert = ownAlerts[0], requirement = requirements[0];
    const next: OverviewAction | null = alert ? {
      clientId: alert.clientId, clientName: knownClients.get(alert.clientId)!.name,
      title: alert.title, detail: alert.detail, href: alert.href,
    } : requirement ? {
      clientId: requirement.client.id, clientName: requirement.client.name,
      title: requirement.check.label, detail: requirement.check.detail || 'Review the ' + requirement.check.state + ' evidence in the existing workflow.',
      href: requirement.check.href,
    } : null;
    return { ...scope, checks, total: Object.values(checks).reduce((a,b) => a+b,0),
      alerts: ownAlerts.length, critical: ownAlerts.filter(a => a.severity === 'critical').length, next };
  });
  return { clients: clients.length, layers: summaries.slice(0,5), support: summaries[5], other: summaries[6],
    partial: data.sourceErrors.length > 0 };
}
