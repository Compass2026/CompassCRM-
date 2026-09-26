// The Authority tab's run controls, as pure rules: which of "Run Full
// Analysis" and "Refresh" may be pressed and why not, and what to say about
// the authority-run function's answer and a finished run. No network, no
// database. The function stays the source of truth: these rules only keep
// the buttons honest, and every refusal it can give is still mapped.
import { activeRun as findActive, changesText, formatWhen, STUCK_AFTER_MS, type RunRow } from "./authority-view.ts";

export { STUCK_AFTER_MS };
export const POLL_INTERVAL_MS = 3000;
export const WATCH_LIMIT_MS = 3 * 60 * 1000;
export const START_TIMEOUT_MS = 15000;

export const HELPER_TEXT =
  "Full analysis crawls the website again. Refresh rechecks current business and search data using the latest site snapshot.";

export type Mode = "full" | "refresh";
export type RunningRun = Pick<RunRow, "id" | "mode" | "created_at">;

export type ControlsInput = {
  clientStatus: string | null;
  hasCompletedRun: boolean;
  staleSections: string[];
  inventoryStale: boolean;
  runs: Pick<RunRow, "id" | "mode" | "created_at" | "status">[];
  now: Date;
};

export type Button = { enabled: boolean; primary: boolean; reason: string | null };
export type ControlsState = {
  visible: boolean;
  full: Button;
  refresh: Button;
  running: RunningRun | null;   // a run in progress (not stuck)
  stuck: RunningRun | null;     // a run left "running" past STUCK_AFTER_MS
  helper: string;
};

// The run in progress, or one left "running" past STUCK_AFTER_MS (the
// buttons stay enabled for a stuck run: the next begin clears it).
export function activeRun(runs: ControlsInput["runs"], now: Date): { running: RunningRun | null; stuck: RunningRun | null } {
  const { running, stuck } = findActive(runs, now);
  const pick = (r: typeof running) => (r ? { id: r.id, mode: r.mode, created_at: r.created_at } : null);
  return { running: pick(running), stuck: pick(stuck) };
}

export function controlsState(input: ControlsInput): ControlsState {
  const { running, stuck } = activeRun(input.runs, input.now);
  const hidden: Button = { enabled: false, primary: false, reason: null };
  if (input.clientStatus === "offboarded") {
    return { visible: false, full: hidden, refresh: hidden, running, stuck, helper: HELPER_TEXT };
  }
  if (running) {
    const reason = `An analysis is running (started ${formatWhen(running.created_at)}).`;
    return {
      visible: true, running, stuck, helper: HELPER_TEXT,
      full: { enabled: false, primary: true, reason },
      refresh: { enabled: false, primary: false, reason },
    };
  }
  const full: Button = { enabled: true, primary: true, reason: null };
  let refresh: Button = { enabled: true, primary: false, reason: null };
  const siteChanged = input.staleSections.includes("site");
  if (!input.hasCompletedRun) {
    refresh = { enabled: false, primary: false, reason: "Needs a full analysis first." };
  } else if (input.inventoryStale || siteChanged) {
    refresh = {
      enabled: false, primary: false,
      reason: siteChanged
        ? "The site record changed since the last snapshot; run a full analysis."
        : "The site snapshot is more than 14 days old; run a full analysis.",
    };
  } else if (input.staleSections.length) {
    // Only CRM or Search Console data changed: a refresh is enough.
    refresh = { enabled: true, primary: true, reason: null };
    full.primary = false;
  }
  return { visible: true, full, refresh, running: null, stuck, helper: HELPER_TEXT };
}

// ── What to say about the function's answer ────────────────────────────────

export type StartOutcome =
  | { kind: "started"; runId: string; text: string }
  | { kind: "running"; runId: string | null; text: string }
  | { kind: "error"; text: string }
  | { kind: "uncertain"; text: string };

const UNCERTAIN =
  "Couldn't confirm that the analysis started (no clear answer from the Authority service). It may have started; the page will show it if so.";

// status: the HTTP status, or null when the request timed out or failed.
export function startOutcome(mode: Mode, status: number | null, body: unknown): StartOutcome {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : null);
  if (status === 202 && str("run_id")) {
    return { kind: "started", runId: str("run_id")!, text: mode === "full" ? "Full analysis started." : "Refresh started." };
  }
  if (status === 409 && str("error") === "run_in_progress") {
    return { kind: "running", runId: str("run_id"), text: "An analysis is already running for this client; showing its progress." };
  }
  if (status === 409 && str("error") === "needs_full_run") {
    return { kind: "error", text: `Refresh isn't possible yet: ${str("detail") ?? "run a full analysis first."}` };
  }
  if (status === 409 && str("error") === "client_offboarded") {
    return { kind: "error", text: "This client is offboarded; Authority doesn't run for offboarded clients." };
  }
  if (status === 404) return { kind: "error", text: "Client not found." };
  if (status === 401 || status === 403) {
    return { kind: "error", text: "Your session expired or you aren't on the Compass team. Sign in again and retry." };
  }
  if (status === 400) return { kind: "error", text: `The request was refused: ${str("error") ?? "bad request"}.` };
  // A timeout, a network error, a 5xx or an unexpected answer: the run may or
  // may not have begun, so never claim either.
  return { kind: "uncertain", text: UNCERTAIN };
}

// ── What to say when a watched run finishes ─────────────────────────────────

export type RunStatus = Pick<RunRow, "id" | "status" | "mode" | "diff" | "error" | "health">;
export type FinishMessage = { tone: "success" | "warning" | "error"; text: string };

export function finishMessage(run: RunStatus): FinishMessage | null {
  if (run.status === "running") return null;
  const what = run.mode === "refresh" ? "Refresh" : "Full analysis";
  if (run.status === "completed") {
    const changes = changesText({ status: run.status, diff: run.diff });
    return { tone: "success", text: `${what} complete: ${changes}.` };
  }
  if (run.status === "degraded") {
    const reasons = (run.health?.reasons ?? []).join("; ") || "no reason recorded";
    return { tone: "warning", text: `${what} finished degraded (${reasons}). Results are unchanged.` };
  }
  return { tone: "error", text: `${what} failed: ${run.error ?? "no reason recorded"}. Results are unchanged.` };
}
