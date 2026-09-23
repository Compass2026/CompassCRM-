import { cn } from "@/lib/utils";

// Shared navigation states, so the header, the client tabs and the view
// switchers all look and behave alike. A "track" is the quiet rail the items
// sit on; the active item is a raised white pill on it.

export const navTrack =
  "flex w-full items-center gap-1 overflow-x-auto rounded-full bg-muted p-1 ring-1 ring-border/70 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

export function navItem(active: boolean): string {
  return cn(
    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
    active
      ? "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(11,22,42,0.08),0_2px_8px_-2px_rgba(11,22,42,0.12)] ring-1 ring-border"
      : "font-medium text-muted-foreground hover:bg-card/70 hover:text-foreground"
  );
}

// Filter chips (owner lane, autonomy, content filters): navy when on.
export function chip(active: boolean): string {
  return cn(
    "inline-flex h-8 items-center rounded-full border px-3 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
    active
      ? "border-primary bg-primary font-medium text-primary-foreground"
      : "border-border bg-card text-muted-foreground hover:border-input hover:text-foreground"
  );
}

// Small count next to a nav item.
export function navCount(tone: "default" | "alert" = "default"): string {
  return cn(
    "rounded-full px-1.5 text-xs font-semibold tabular-nums",
    tone === "alert" ? "bg-red-100 text-red-800" : "bg-mist-200 text-navy-700"
  );
}
