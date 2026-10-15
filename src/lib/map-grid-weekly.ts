// Weekly map-grid scan health: is there a successful scan for the ISO week
// whose Thursday slot has passed? Pure, so the client tab and Control Center
// read the same rule.
const DAY = 86400000;
const HOUR = 3600000;
// pg_cron `map-grid-weekly` fires Thursdays 14:00 UTC.
export const WEEKLY_SLOT_MS = 3 * DAY + 14 * HOUR;
// Six-hour collection expiry plus an hour's grace before a running week is "missed".
export const WEEKLY_SETTLE_MS = 7 * HOUR;
// A start attempt is written within seconds of the slot; an hour without one is a missed trigger.
export const WEEKLY_START_GRACE_MS = HOUR;

export type WeeklyAttempt = {
  outcome: "started" | "already_running" | "cooldown" | "disabled" | "error" | string;
  message: string | null;
  attempted_at: string;
  run_id?: string | null;
};
export type WeeklyRun = { started_at: string; status: string; error?: string | null };
export type WeeklyScanStatus = {
  state: "off" | "ok" | "due" | "scanning" | "missed";
  week: string;
  severity: "critical" | "attention" | null;
  title: string;
  detail: string;
  lastSuccessAt: string | null;
  attempt: WeeklyAttempt | null;
};

export function isoWeekStart(t: number): number {
  const d = new Date(t);
  return (
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
    ((d.getUTCDay() + 6) % 7) * DAY
  );
}
export function isoWeekLabel(weekStart: number): string {
  const year = new Date(weekStart + 3 * DAY).getUTCFullYear();
  const week = Math.round((weekStart - isoWeekStart(Date.UTC(year, 0, 4))) / (7 * DAY)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}
const outcomeText: Record<string, string> = {
  started: "started",
  already_running: "skipped: a scan was already running",
  cooldown: "skipped: another scan started within the hour",
  disabled: "skipped: the profile was disabled",
  error: "failed to start",
};

export function weeklyScanStatus(input: {
  enabled: boolean;
  weeklyEnabled: boolean;
  runs: WeeklyRun[];
  attempts: WeeklyAttempt[];
  now: string;
}): WeeklyScanStatus {
  const t = Date.parse(input.now);
  const thisWeek = isoWeekStart(t);
  const slot = thisWeek + WEEKLY_SLOT_MS;
  // Before this Thursday's slot, the scan that should exist is last week's.
  const week = t < slot ? thisWeek - 7 * DAY : thisWeek;
  const label = isoWeekLabel(week);
  const byNewest = <T,>(rows: T[], at: (r: T) => string) =>
    [...rows].sort((a, b) => Date.parse(at(b)) - Date.parse(at(a)));
  const complete = byNewest(
    input.runs.filter((r) => r.status === "complete"),
    (r) => r.started_at,
  );
  const lastSuccessAt = complete[0]?.started_at ?? null;
  const base = { week: label, lastSuccessAt };
  if (!input.enabled || !input.weeklyEnabled)
    return { ...base, state: "off", severity: null, title: "Weekly scan off", detail: "This profile is not scheduled for weekly scans.", attempt: null };
  // A scan at or after the expected week's start counts, manual scans included.
  if (complete.some((r) => Date.parse(r.started_at) >= week))
    return { ...base, state: "ok", severity: null, title: `Weekly scan complete for ${label}`, detail: "A complete scan exists for the expected week.", attempt: null };
  const inWeek = (at: string) => Date.parse(at) >= week && Date.parse(at) < week + 7 * DAY;
  const attempt = byNewest(input.attempts.filter((a) => inWeek(a.attempted_at)), (a) => a.attempted_at)[0] ?? null;
  const weekRuns = byNewest(input.runs.filter((r) => inWeek(r.started_at)), (r) => r.started_at);
  const running = input.runs.some((r) => r.status === "running");
  const noStart = `No weekly start was recorded for ${label}. Check the map-grid-weekly cron job and map-grid-sync logs.`;
  if (attempt?.outcome === "error")
    return { ...base, state: "missed", severity: "critical", title: `Weekly scan failed to start (${label})`, detail: attempt.message ?? "The start error was not recorded.", attempt };
  if (week === thisWeek && t < slot + WEEKLY_SETTLE_MS) {
    if (running)
      return { ...base, state: "scanning", severity: null, title: `Weekly scan in progress (${label})`, detail: "Results are still being collected.", attempt };
    if (!attempt && t > slot + WEEKLY_START_GRACE_MS)
      return { ...base, state: "missed", severity: "critical", title: `Weekly scan did not start (${label})`, detail: noStart, attempt };
    if (!attempt)
      return { ...base, state: "due", severity: null, title: `Weekly scan due (${label})`, detail: "Scheduled for Thursday 14:00 UTC.", attempt };
  }
  if (!attempt && !weekRuns.length)
    return { ...base, state: "missed", severity: "critical", title: `No successful weekly scan (${label})`, detail: noStart, attempt };
  const last = weekRuns[0];
  const why = last
    ? `Latest scan this week ended ${last.status}${last.error ? `: ${last.error}` : ""}.`
    : `Weekly start ${outcomeText[attempt!.outcome] ?? attempt!.outcome}${attempt!.message ? `: ${attempt!.message}` : ""}.`;
  return { ...base, state: "missed", severity: "attention", title: `No successful weekly scan (${label})`, detail: why, attempt };
}
