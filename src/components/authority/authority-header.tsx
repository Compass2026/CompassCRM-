import { Badge } from "@/components/ui/badge";
import type { AuthorityView } from "@/lib/authority-view";
import { cn } from "@/lib/utils";
import { toneStyles } from "./tones";

const stateBadge: Record<string, { label: string; className: string }> = {
  current: { label: "Current", className: "bg-green-100 text-green-800 border-green-200" },
  stale: { label: "Stale", className: "bg-amber-100 text-amber-800 border-amber-200" },
  running: { label: "Running", className: "bg-royal-50 text-royal-700 border-royal-100" },
  attempt_problem: { label: "Latest attempt did not complete", className: "bg-red-100 text-red-800 border-red-200" },
};

export function AuthorityHeader({ header }: { header: NonNullable<AuthorityView["header"]> }) {
  const state = stateBadge[header.state];
  return (
    <section className="surface-tint space-y-3 p-4 sm:p-6" aria-label="Latest analysis">
      <p className="eyebrow">Authority</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-xl font-bold tracking-tight">Last analyzed {header.lastAnalyzed}</h2>
        <Badge variant="outline" className={state.className} data-state={header.state}>{state.label}</Badge>
      </div>
      <ul className="flex flex-wrap gap-2 text-xs">
        <li className="rounded-full bg-card px-2.5 py-1 ring-1 ring-royal-100">{header.mode}</li>
        <li className="rounded-full bg-card px-2.5 py-1 ring-1 ring-royal-100">{header.engine}</li>
        {header.pagesChecked != null && (
          <li className="rounded-full bg-card px-2.5 py-1 ring-1 ring-royal-100">
            {header.pagesChecked} pages checked{header.urlsRequested != null ? ` (${header.urlsRequested} URLs)` : ""}
          </li>
        )}
        {header.gsc && (
          <li className={cn("rounded-full px-2.5 py-1 ring-1", header.gsc.coverage === "complete" ? "bg-card ring-royal-100" : "bg-amber-50 text-amber-900 ring-amber-200")}>
            Search Console {header.gsc.coverage} · {header.gsc.rows.toLocaleString("en-US")} rows
            {header.gsc.window ? ` · ${header.gsc.window}` : ""}
            {header.gsc.cap ? ` · capped at ${header.gsc.cap.toLocaleString("en-US")}` : ""}
          </li>
        )}
      </ul>
      <p className="max-w-3xl text-sm text-muted-foreground">
        What the Authority Engine found on the latest completed analysis: what to fix, what content the governed facts
        already support, and what a person must decide. Read-only; nothing here changes the site, the CRM or Google.
      </p>
    </section>
  );
}

export function AuthoritySummary({ summary }: { summary: AuthorityView["summary"] }) {
  return (
    <nav aria-label="Authority sections" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {summary.map((s) => {
        const tone = toneStyles[s.tone];
        return (
          <a
            key={s.section}
            href={`#section-${s.section}`}
            data-summary={s.section}
            className={cn("rounded-xl border px-3 py-2.5 transition-colors hover:brightness-95", tone.card)}
          >
            <span className={cn("flex items-center gap-1.5 text-xs font-semibold", tone.text)}>
              <span aria-hidden="true" className={cn("size-2 rounded-full", tone.dot)} />
              {s.label}
            </span>
            <span className="mt-0.5 block text-2xl font-bold tabular-nums text-navy-900" data-count>{s.count}</span>
          </a>
        );
      })}
    </nav>
  );
}

const bannerStyles: Record<string, string> = {
  running: "border-royal-100 bg-royal-50 text-navy-900",
  stale: "border-amber-200 bg-amber-50 text-amber-950",
  degraded: "border-amber-200 bg-amber-50 text-amber-950",
  failed: "border-red-200 bg-red-50 text-red-900",
};

export function AuthorityBanners({ banners }: { banners: AuthorityView["banners"] }) {
  if (!banners.length) return null;
  return (
    <div className="space-y-2">
      {banners.map((b) => (
        <div key={b.kind} role="status" data-banner={b.kind} className={cn("callout", bannerStyles[b.kind])}>
          <p className="font-semibold">{b.title}</p>
          <p className="mt-0.5">{b.body}</p>
        </div>
      ))}
    </div>
  );
}
