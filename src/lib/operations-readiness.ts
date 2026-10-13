// Pure source-freshness and action/readiness rules for Control Center 2.0.
// Read-only: labels distinguish verified records, missing evidence and failed reads.
import { SOURCE_POLICY, type IntegrationEvidence } from "./integration-health.ts";
import type { ClientHealth } from "./operations-health";

export type SourceKey = "gsc" | "ga4" | "gbp";
export type Freshness = "current" | "stale" | "missing" | "unknown";
export type SourceReading = {
  state: Freshness;
  windowEnd: string | null;
  ageDays: number | null;
};
export type MeasureRow = {
  client_id: string;
  source: string;
  window_end: string;
  created_at: string;
};
export type BrandRow = { client_id: string; id: string; status: string; blog_site_id: string | null };
export type BoardRow = { client_id: string; status: string };
export type IntakeRow = { client_id: string; enabled: boolean };
export type DraftRow = {
  id: string; client_id: string; status: string; title: string | null;
  topic: string | null; request_task_id: string | null; created_at: string;
};
export type ReleaseRow = {
  id: string; client_id: string; draft_id: string; status: string;
  last_error: string | null; released_at: string;
};
export type Alert = {
  id: string; clientId: string; clientName: string;
  severity: "critical" | "attention" | "setup";
  title: string; detail: string; href: string;
};
export type ReadinessCheck = {
  key: string; label: string;
  state: "recorded" | "missing" | "unknown" | "blocked" | "waiting";
  href: string;
};
export type ClientReadiness = {
  id: string; name: string; readiness: ReadinessCheck[];
  recorded: number; unknown: number;
  freshness: Record<SourceKey, SourceReading>;
  multiBrand: boolean;
};
export type OperationsV2 = {
  clients: ClientReadiness[];
  alerts: Alert[];
  sourceErrors: string[];
  generatedAt: string;
  integrations: IntegrationEvidence[];
};
export type OperationsV2Input = {
  clients: ClientHealth[];
  measured: MeasureRow[] | null;
  brands: BrandRow[] | null;
  boards: BoardRow[] | null;
  intake: IntakeRow[] | null;
  drafts: DraftRow[] | null;
  releases: ReleaseRow[] | null;
  sourceErrors: string[];
  now: string;
  integrations?: IntegrationEvidence[];
};
const PROVIDERS: Record<SourceKey, string> = {
  gsc: "Google Search Console property totals",
  ga4: "Google Analytics 4",
  gbp: "Google Business Profile via Zernio",
};
const DAYS = 86400000;
// This is measurement-window freshness, not a provider authorization test.
// Monthly reporting can be 45 days behind without implying a broken token.
export const MEASUREMENT_MAX_AGE_DAYS = 45;
export const REQUEST_MAX_AGE_HOURS = 24;
const parseTime = (value: string): number | null => {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
};
export function measurementFreshness(
  rows: MeasureRow[] | null, clientId: string, source: SourceKey, now: string,
): SourceReading {
  if (rows === null) return { state: "unknown", windowEnd: null, ageDays: null };
  const forClient = rows.filter((r) => r.client_id === clientId && r.source === PROVIDERS[source]);
  if (!forClient.length) return { state: "missing", windowEnd: null, ageDays: null };
  const sorted = forClient.filter((r) => parseTime(r.window_end) !== null)
    .sort((a, b) => (parseTime(b.window_end) ?? 0) - (parseTime(a.window_end) ?? 0));
  const latest = sorted[0];
  const checkAt = parseTime(now);
  if (!latest || checkAt === null) return { state: "unknown", windowEnd: null, ageDays: null };
  const ageDays = Math.floor((checkAt - (parseTime(latest.window_end) ?? checkAt)) / DAYS);
  if (ageDays < -1) return { state: "unknown", windowEnd: latest.window_end, ageDays: null };
  return {
    state: ageDays > MEASUREMENT_MAX_AGE_DAYS ? "stale" : "current",
    windowEnd: latest.window_end,
    ageDays: Math.max(0, ageDays),
  };
}
function makeCheck(key: string, label: string, observed: boolean | null, href: string): ReadinessCheck {
  return { key, label, state: observed === null ? "unknown" : observed ? "recorded" : "missing", href };
}
const known = <T>(rows: T[] | null, test: (row: T) => boolean): boolean | null =>
  rows === null ? null : rows.some(test);

export function buildOperationsV2(input: OperationsV2Input): OperationsV2 {
  const now = parseTime(input.now);
  const alerts: Alert[] = [];
  const clients = input.clients.map((c): ClientReadiness => {
    const base = "/clients/" + c.id;
    const source = {
      gsc: measurementFreshness(input.measured, c.id, "gsc", input.now),
      ga4: measurementFreshness(input.measured, c.id, "ga4", input.now),
      gbp: measurementFreshness(input.measured, c.id, "gbp", input.now),
    };
    const brandRows = input.brands?.filter((b) => b.client_id === c.id) ?? [];
    const multiBrand = input.brands !== null && brandRows.length > 1;
    const brandApproved = input.brands === null || input.boards === null ? null :
      (brandRows.length > 0
        ? brandRows.every((b) => b.status === "approved")
        : input.boards.some((b) => b.client_id === c.id && b.status === "approved"));
    const checks = [
      makeCheck("brand", "Approved brand foundation", brandApproved, base + "/brand"),
      makeCheck("keywords", "Tracked keyword strategy", c.keywordsTracked === null ? null : c.keywordsTracked > 0, base + "/keywords"),
      makeCheck("website", "Compass-managed website recorded", c.websites === null ? null : c.websites > 0, base),
      makeCheck("search", "Search Console measurements", source.gsc.state === "unknown" ? null : source.gsc.state !== "missing", base + "/growth"),
      makeCheck("analytics", "GA4 measurements", source.ga4.state === "unknown" ? null : source.ga4.state !== "missing", base + "/growth"),
      makeCheck("publishing", "Publishing account connected", c.publishingAccounts === null ? null : c.publishingAccounts > 0, base + "/social"),
      makeCheck("intake", "CRM Lite intake source enabled", known(input.intake, (r) => r.client_id === c.id && r.enabled), base + "/inquiries"),
      makeCheck("billing", "LIVE subscription recorded in CRM", c.liveSubscriptions === null ? null : c.liveSubscriptions > 0, base + "/billing"),
      makeCheck("portal", "Client portal user enrolled", c.portalMembers === null ? null : c.portalMembers > 0, base),
    ];
    if (input.integrations) {
      for (const [key, sourceKey, label] of [["search","gsc","Search Console reporting verified"],["analytics","ga4","GA4 reporting verified"],["gbp","gbp","GBP reporting verified"]] as const) {
        const evidence=input.integrations.find(e=>e.clientId===c.id && e.source===sourceKey);
        const check: ReadinessCheck={key,label,href:base+"/growth",state:
          !evidence || evidence.state === "unknown" ? "unknown" : evidence.state === "verified" ? "recorded" :
          evidence.state === "running" ? "waiting" : evidence.state === "unconfigured" || evidence.state === "missing" ? "missing" : "blocked"};
        const index=checks.findIndex(r=>r.key===key);
        if(index<0) checks.push(check); else checks[index]=check;
      }
    }
    const warn = (
      type: Alert["severity"], key: string, title: string, detail: string, href: string,
    ) => alerts.push({ id: c.id + ":" + key, clientId: c.id, clientName: c.name, severity: type, title, detail, href });

    const releases = input.releases?.filter((r) => r.client_id === c.id) ?? [];
    for (const rel of releases) {
      if (rel.status === "blocked" || rel.status === "uncertain") {
        warn("critical", "release:" + rel.id,
          rel.status === "uncertain" ? "Publication needs reconciliation" : "Publication blocked",
          rel.last_error || "Review the release receipt before taking action. Never blindly requeue an uncertain publish.",
          base + "/drafts/" + rel.draft_id);
      } else if (rel.status === "queued" && now !== null) {
        const at = parseTime(rel.released_at);
        if (at !== null && now - at > 35 * 60000) {
          warn("attention", "queued:" + rel.id, "Publication queued over 35 minutes",
            "Check the scheduled release and publisher status; it may have a future publish time.",
            base + "/drafts/" + rel.draft_id);
        }
      }
    }
    for (const d of input.drafts?.filter((r) => r.client_id === c.id) ?? []) {
      if (d.status === "in_review") {
        warn("attention", "review:" + d.id, "Article waiting for approval",
          d.title || d.topic || "Open the draft and review the sourced article.", base + "/drafts/" + d.id);
      }
      if (d.status === "requested" && !d.request_task_id && now !== null) {
        const at = parseTime(d.created_at);
        if (at !== null && now - at >= REQUEST_MAX_AGE_HOURS * 3600000) {
          warn("attention", "orphan:" + d.id, "Draft request has no worker task",
            "Check the existing request before generating again; preserve the original draft ID.",
            base + "/drafts/" + d.id);
        }
      }
    }
    if (c.sitesMissingProject !== null && c.sitesMissingProject > 0) {
      warn("critical", "site", "Website missing deployment project",
        "Check domain, repo and deployment mapping before the next publish.", base);
    }
    for (const [key, reading] of Object.entries(source) as [SourceKey, SourceReading][]) {
      if (reading.state === "stale") {
        warn("attention", "stale:" + key, key.toUpperCase() + " measurement window is old",
          "Latest observed period ends " + reading.windowEnd + ". Validate source freshness; this does not prove an API outage.",
          base + "/growth");
      }
    }
    if (c.crmLite === "sms_off" && c.alertsBlocked !== null && c.alertsBlocked > 0) {
      warn("setup", "sms", "SMS inquiry alerts disabled",
        c.alertsBlocked + " recorded alerts are blocked. Verify consent, sender and delivery before enabling.",
        base + "/inquiries");
    }
    if (multiBrand) {
      warn("setup", "brands", "Multiple brands share one parent client",
        "Confirm GA4, GSC and content metrics by brand/site, not just parent-client totals.",
        base + "/brand");
    }
    return {
      id: c.id, name: c.name, readiness: checks,
      recorded: checks.filter((a) => a.state === "recorded").length,
      unknown: checks.filter((a) => a.state === "unknown").length,
      freshness: source, multiBrand,
    };
  });
  for (const entry of input.integrations ?? []) {
    const client=input.clients.find(c=>c.id===entry.clientId);
    if (!client || entry.state === "verified" || entry.state === "running") continue;
    alerts.push({id:`${entry.clientId}:integration:${entry.source}`,clientId:client.id,clientName:client.name,
      severity:entry.state === "failed" ? "critical" : entry.state === "unconfigured" ? "setup" : "attention",
      title:SOURCE_POLICY[entry.source].label+" · "+entry.state,
      detail:entry.evidence+" Next: "+entry.nextAction,
      href:entry.state === "unconfigured" ? `/clients/${client.id}${entry.source === "gbp" ? "/social" : ""}` : entry.href});
  }
  const order: Record<Alert["severity"], number> = { critical: 0, attention: 1, setup: 2 };
  alerts.sort((a, b) => order[a.severity] - order[b.severity] ||
    a.clientName.localeCompare(b.clientName) || a.title.localeCompare(b.title));
  return { clients, alerts, sourceErrors: input.sourceErrors, generatedAt: input.now, integrations: input.integrations ?? [] };
}
