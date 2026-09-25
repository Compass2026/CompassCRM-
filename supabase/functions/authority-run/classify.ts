// authority-run's pure rules: whether a run is completed or degraded, the
// input hash, and the payload authority_record_run (0048) receives. No
// network, no database.
import { allowedUrl, type Inventory } from "../authority/inventory.ts";
import type { AuthorityReport, SitePage } from "../authority/types.ts";

// 25% or more of the requested URLs erroring makes the observation unreliable.
export const DEGRADED_ERROR_SHARE = 0.25;

export type RunHealth = { status: "completed" | "degraded"; inventory_errors: number; reasons: string[] };

// An error is an outage, not a finding: no response at all, a 5xx, or an
// on-site redirect chain that ended without an answer. A 404, a redirect
// loop and a redirect off the site are findings the engine reports.
export function isErrorPage(p: SitePage, site: string): boolean {
  if (p.status === null) return true;
  if (p.status >= 500 || (p.final_status !== null && p.final_status >= 500)) return true;
  return p.final_status === null && !p.redirect_loop && p.final_url !== null && allowedUrl(p.final_url, site);
}

// Degraded: the home page did not answer 2xx, 25% or more of the requested
// URLs errored, or the inventory ran out of its time budget. No site URL is
// not an outage: the run completes and the engine reports owner pages as
// not checked.
export function classifyRun(siteUrl: string | null, inv: Pick<Inventory, "site" | "pages" | "budget_exceeded"> | null): RunHealth {
  if (!siteUrl || !inv) return { status: "completed", inventory_errors: 0, reasons: siteUrl ? ["no inventory"] : ["no site URL"] };
  const reasons: string[] = [];
  const home = `${new URL(inv.site).origin}/`;
  const h = inv.pages.find((p) => p.url === home);
  const homeStatus = h ? (h.final_status ?? null) : null;
  if (homeStatus === null || homeStatus < 200 || homeStatus >= 300) reasons.push(`home page answered ${homeStatus ?? "nothing"}`);
  const errors = inv.pages.filter((p) => isErrorPage(p, inv.site)).length;
  if (inv.pages.length && errors / inv.pages.length >= DEGRADED_ERROR_SHARE) reasons.push(`${errors} of ${inv.pages.length} URLs errored`);
  if (inv.budget_exceeded) reasons.push("the inventory ran out of its time budget");
  return { status: reasons.length ? "degraded" : "completed", inventory_errors: errors, reasons };
}

// Canonical JSON: object keys sorted, recursively.
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

// sha256 over the engine input, less what changes on every read without
// changing the judgment: authority.now, asOf and the inventory's fetched_at.
export async function inputHash(input: Record<string, unknown>): Promise<string> {
  const a = { ...(input.authority as Record<string, unknown>) };
  delete a.now;
  if (a.inventory && typeof a.inventory === "object") {
    const { fetched_at: _f, ...rest } = a.inventory as Record<string, unknown>;
    a.inventory = rest;
  }
  const { asOf: _a, ...restInput } = input;
  const bytes = new TextEncoder().encode(canonical({ ...restInput, authority: a }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export type RecordPayload = {
  status: "completed" | "degraded";
  engine_version: string;
  judged_at: string;
  as_of: string;
  input_hash: string;
  section_hashes: Record<string, unknown>;
  // the observation, with why the run is degraded (if it is) alongside it
  inventory: (Inventory & { health: RunHealth }) | null;
  inventory_errors: number;
  report: AuthorityReport;
};

// The checks authority_record_run makes, made first so a malformed report
// fails as a clear error rather than a database exception.
export function validatePayload(p: RecordPayload, clientId: string): string | null {
  if (p.report?.client?.id !== clientId) return "the report is not for this run's client";
  if (!/^sha256:[0-9a-f]{64}$/.test(p.input_hash)) return "input_hash is malformed";
  if (!/^authority-v[0-9.]+$/.test(p.engine_version)) return "engine_version is malformed";
  if (!p.judged_at || Number.isNaN(Date.parse(p.judged_at))) return "judged_at is missing";
  const keys = (p.report.opportunities ?? []).map((o) => o.key);
  if (keys.some((k) => !k)) return "an opportunity has no key";
  if (new Set(keys).size !== keys.length) return "opportunity keys are not unique";
  if (!keys.every((k) => /^[a-z_]+:[A-Za-z0-9_:/.'-]+$/.test(k) && k.length <= 300)) return "an opportunity key is malformed";
  return null;
}

// A failure message for the run row: short, and never a credential.
export function safeError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/(bearer\s+)[\w.-]+/gi, "$1[redacted]").replace(/(secret|token|key|password)=[^&\s]+/gi, "$1=[redacted]").slice(0, 500) || "Failed.";
}
