// Colour for the Authority tab's section tones, tiers and page states.
export const toneStyles: Record<string, { card: string; dot: string; text: string }> = {
  red: { card: "border-red-200 bg-red-50/70", dot: "bg-red-500", text: "text-red-800" },
  green: { card: "border-green-200 bg-green-50/70", dot: "bg-green-500", text: "text-green-800" },
  amber: { card: "border-amber-200 bg-amber-50/70", dot: "bg-amber-500", text: "text-amber-800" },
  blue: { card: "border-royal-100 bg-royal-50", dot: "bg-royal-500", text: "text-royal-700" },
  slate: { card: "border-slate-300 bg-slate-100/80", dot: "bg-slate-700", text: "text-slate-800" },
  muted: { card: "border-border bg-muted/60", dot: "bg-muted-foreground", text: "text-muted-foreground" },
};

export const tierStyles: Record<string, string> = {
  A: "bg-red-100 text-red-800 border-red-200",
  B: "bg-amber-100 text-amber-800 border-amber-200",
  C: "bg-slate-100 text-slate-700 border-slate-200",
  none: "bg-muted text-muted-foreground border-border",
};

export const pageStateStyles: Record<string, string> = {
  live: "bg-green-100 text-green-800 border-green-200",
  missing: "bg-red-100 text-red-800 border-red-200",
  redirects: "bg-amber-100 text-amber-800 border-amber-200",
  redirect_loop: "bg-red-100 text-red-800 border-red-200",
  error: "bg-red-100 text-red-800 border-red-200",
  not_checked: "bg-muted text-muted-foreground border-border",
};

export const runStatusStyles: Record<string, string> = {
  completed: "bg-green-100 text-green-800 border-green-200",
  degraded: "bg-amber-100 text-amber-800 border-amber-200",
  failed: "bg-red-100 text-red-800 border-red-200",
  running: "bg-royal-50 text-royal-700 border-royal-100",
};

export const tagStyles: Record<string, string> = {
  FACT: "bg-navy-900 text-white ring-navy-900",
  HEURISTIC: "bg-royal-50 text-royal-700 ring-royal-100",
  RESEARCH_REQUIRED: "bg-sky-50 text-sky-800 ring-sky-200",
  REQUIRES_CONFIRMATION: "bg-amber-50 text-amber-800 ring-amber-200",
};
