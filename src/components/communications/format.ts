// Display helpers for the Communications pages (Central time, the team's day).
const TZ = "America/Chicago";

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" });
}

export const tone = {
  good: "bg-green-100 text-green-800 border-green-200",
  wait: "bg-blue-100 text-blue-800 border-blue-200",
  warn: "bg-amber-100 text-amber-900 border-amber-200",
  bad: "bg-red-100 text-red-800 border-red-200",
  none: "bg-zinc-100 text-zinc-600 border-zinc-200",
} as const;

export function pipelineTone(status: string): string {
  switch (status) {
    case "approved": return tone.good;
    case "rejected": case "blocked": return tone.bad;
    case "restricted": return tone.warn;
    case "not_configured": return tone.none;
    default: return tone.wait;
  }
}

export function registrationTone(status: string): string {
  switch (status) {
    case "approved": return tone.good;
    case "rejected": return tone.bad;
    case "draft": return tone.none;
    default: return tone.wait;
  }
}

export function messageTone(status: string): string {
  switch (status) {
    case "delivered": case "read": case "received": return "text-green-800";
    case "failed": case "undelivered": case "canceled": return "text-red-700";
    default: return "text-muted-foreground";
  }
}
