import { AlertTriangle, CalendarCheck2, Clock3 } from "lucide-react";
import type { WeeklyAttempt, WeeklyScanStatus } from "@/lib/map-grid-weekly";

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", {
        timeZone: "America/Chicago",
        dateStyle: "medium",
        timeStyle: "short",
      }) + " CT"
    : "None recorded";
const outcomeLabel: Record<string, string> = {
  started: "Started",
  already_running: "Skipped: already running",
  cooldown: "Skipped: within an hour of another scan",
  disabled: "Skipped: profile disabled",
  error: "Failed to start",
};

// Weekly schedule health for one map-grid profile. Read-only; never starts a scan.
export function MapGridWeeklyNotice({
  status,
  attempts,
}: {
  status: WeeklyScanStatus;
  attempts: WeeklyAttempt[];
}) {
  if (status.state === "off") return null;
  const missed = status.state === "missed";
  const tone = !missed
    ? "border-slate-200 bg-card text-slate-700"
    : status.severity === "critical"
      ? "border-red-200 bg-red-50 text-red-900"
      : "border-amber-200 bg-amber-50 text-amber-900";
  const Icon = missed ? AlertTriangle : status.state === "ok" ? CalendarCheck2 : Clock3;
  return (
    <section
      className={`rounded-2xl border p-4 text-sm ${tone}`}
      role={missed ? "alert" : undefined}
      data-weekly-scan-state={status.state}
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{status.title}</p>
          <p className="mt-1 break-words text-xs leading-5 opacity-90">{status.detail}</p>
          <p className="mt-1 text-xs opacity-75">
            Last complete scan: {when(status.lastSuccessAt)}
          </p>
          {attempts.length > 0 && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer font-medium">
                Recent weekly start attempts
              </summary>
              <ul className="mt-2 space-y-1">
                {attempts.slice(0, 8).map((a) => (
                  <li key={a.attempted_at + a.outcome} className="break-words">
                    <span className="tabular-nums">{when(a.attempted_at)}</span> ·{" "}
                    {outcomeLabel[a.outcome] ?? a.outcome}
                    {a.message ? ` — ${a.message}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}
