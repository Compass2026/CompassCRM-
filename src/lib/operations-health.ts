// Read-only operations health model for the agency-wide Control Center.
// A null source means the query failed or was unavailable; [] means a
// successful query with no rows. Do not turn missing observations into zero.
export type HealthClient = { id: string; name: string; status: string };
export type ClientRecord = { client_id: string };
export type HealthInputs = {
  clients: HealthClient[];
  keywords: (ClientRecord & { is_active: boolean; is_tracked: boolean })[] | null;
  sites: (ClientRecord & { controlled_by_compass: boolean; vercel_project: string | null })[] | null;
  gsc: ClientRecord[] | null;
  ga4: ClientRecord[] | null;
  gbp: ClientRecord[] | null;
  drafts: (ClientRecord & { status: string })[] | null;
  publications: (ClientRecord & { status: string; id: string })[] | null;
  lite: (ClientRecord & { enabled: boolean; sms_alerts_enabled: boolean })[] | null;
  notifications: (ClientRecord & { status: string; block_reason: string | null })[] | null;
  backlinks: (ClientRecord & { stage: string })[] | null;
  social: (ClientRecord & { publish_enabled: boolean })[] | null;
  subscriptions: (ClientRecord & { livemode: boolean; status: string })[] | null;
  portal: (ClientRecord & { is_active: boolean })[] | null;
};
export type ClientHealth = {
  id: string;
  name: string;
  status: string;
  keywordsTracked: number | null;
  websites: number | null;
  sitesMissingProject: number | null;
  hasGsc: boolean | null;
  hasGa4: boolean | null;
  hasGbp: boolean | null;
  inReview: number | null;
  published: number | null;
  publicationProblems: number | null;
  crmLite: "sms_enabled" | "sms_off" | "not_enabled" | "unknown";
  alertsBlocked: number | null;
  backlinkResearch: number | null;
  backlinkActive: number | null;
  publishingAccounts: number | null;
  liveSubscriptions: number | null;
  portalMembers: number | null;
};
export type HealthSummary = {
  clients: ClientHealth[];
  counts: {
    clients: number;
    trackedKeywords: number | null;
    inReview: number | null;
    published: number | null;
    publicationProblems: number | null;
    alertsBlocked: number | null;
    liveSubscriptions: number | null;
  };
  coverage: { gsc: number | null; ga4: number | null; gbp: number | null };
};
const count = <T extends ClientRecord>(
  rows: T[] | null,
  client: string,
  predicate: (row: T) => boolean = () => true,
): number | null => rows === null ? null : rows.filter((r) => r.client_id === client && predicate(r)).length;

const sum = (numbers: (number | null)[]): number | null =>
  numbers.some((n) => n === null) ? null : numbers.reduce<number>((a, b) => a + (b ?? 0), 0);

const coverage = (clients: ClientHealth[], key: "hasGsc" | "hasGa4" | "hasGbp"): number | null =>
  clients.some((c) => c[key] === null) ? null : clients.filter((c) => c[key]).length;

export function buildOperationsHealth(input: HealthInputs): HealthSummary {
  const clients = input.clients
    .filter((c) => c.status === "active" || c.status === "launching")
    .map((client): ClientHealth => {
      const id = client.id;
      const setting = input.lite?.find((x) => x.client_id === id);
      return {
        id,
        name: client.name,
        status: client.status,
        keywordsTracked: count(input.keywords, id, (x) => x.is_active && x.is_tracked),
        websites: count(input.sites, id, (x) => x.controlled_by_compass),
        sitesMissingProject: count(input.sites, id, (x) => x.controlled_by_compass && !x.vercel_project),
        hasGsc: input.gsc === null ? null : input.gsc.some((x) => x.client_id === id),
        hasGa4: input.ga4 === null ? null : input.ga4.some((x) => x.client_id === id),
        hasGbp: input.gbp === null ? null : input.gbp.some((x) => x.client_id === id),
        inReview: count(input.drafts, id, (x) => x.status === "in_review"),
        // These are completed, verified release records; drafts may remain
        // approved even after publication, so never count draft status here.
        published: count(input.publications, id, (x) => x.status === "published"),
        publicationProblems: count(input.publications, id, (x) => x.status === "blocked" || x.status === "uncertain"),
        crmLite: input.lite === null ? "unknown" : !setting?.enabled ? "not_enabled" :
          setting.sms_alerts_enabled ? "sms_enabled" : "sms_off",
        alertsBlocked: count(input.notifications, id, (x) => x.status === "blocked"),
        backlinkResearch: count(input.backlinks, id, (x) => x.stage === "research"),
        backlinkActive: count(input.backlinks, id, (x) => x.stage !== "research"),
        publishingAccounts: count(input.social, id, (x) => x.publish_enabled),
        liveSubscriptions: count(input.subscriptions, id, (x) => x.livemode && x.status === "active"),
        portalMembers: count(input.portal, id, (x) => x.is_active),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  return {
    clients,
    counts: {
      clients: clients.length,
      trackedKeywords: sum(clients.map((c) => c.keywordsTracked)),
      inReview: sum(clients.map((c) => c.inReview)),
      published: sum(clients.map((c) => c.published)),
      publicationProblems: sum(clients.map((c) => c.publicationProblems)),
      alertsBlocked: sum(clients.map((c) => c.alertsBlocked)),
      liveSubscriptions: sum(clients.map((c) => c.liveSubscriptions)),
    },
    coverage: {
      gsc: coverage(clients, "hasGsc"),
      ga4: coverage(clients, "hasGa4"),
      gbp: coverage(clients, "hasGbp"),
    },
  };
}
