import { Badge } from "@/components/ui/badge";
import { TAG_LABEL, type Card } from "@/lib/authority-view";
import { cn } from "@/lib/utils";
import { pageStateStyles, tagStyles, tierStyles } from "./tones";

const pageStateLabel: Record<string, string> = {
  live: "live", missing: "missing", redirects: "redirects", redirect_loop: "redirect loop", error: "error", not_checked: "not checked",
};

function Chips({ card }: { card: Card }) {
  return (
    <span className="flex flex-wrap gap-1">
      {card.provenance.map((p) => (
        <span
          key={p.tag}
          className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ring-1", tagStyles[p.tag])}
          title={`${p.count} ${TAG_LABEL[p.tag].toLowerCase()} statement${p.count === 1 ? "" : "s"}`}
        >
          {TAG_LABEL[p.tag]} {p.count}
        </span>
      ))}
    </span>
  );
}

function Target({ card }: { card: Card }) {
  if (!card.target) return null;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      <code className="break-all rounded bg-muted px-1.5 py-0.5 text-xs text-navy-800">{card.target.path}</code>
      {card.target.state && (
        <Badge variant="outline" className={cn("h-5 px-1.5 text-[11px]", pageStateStyles[card.target.state] ?? pageStateStyles.not_checked)}>
          {pageStateLabel[card.target.state] ?? card.target.state}
        </Badge>
      )}
    </span>
  );
}

function Details({ card }: { card: Card }) {
  const d = card.details;
  return (
    <details className="group/details mt-2 text-xs">
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">Details</summary>
      <div className="mt-2 space-y-3 rounded-xl bg-muted/50 p-3 ring-1 ring-border">
        {d.objective && <p><span className="font-semibold">Objective:</span> {d.objective}</p>}
        <div>
          <p className="font-semibold">Reasons</p>
          <ul className="mt-1 space-y-1">
            {d.reasons.map((r, i) => (
              <li key={i} className="flex gap-2">
                <span className={cn("h-fit shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1", tagStyles[r.tag])}>{TAG_LABEL[r.tag]}</span>
                <span className="min-w-0 break-words">{r.text}</span>
              </li>
            ))}
          </ul>
        </div>
        {d.gates.length > 0 && (
          <div>
            <p className="font-semibold">Gates</p>
            <ul className="mt-1 space-y-0.5">
              {d.gates.map((g) => (
                <li key={g.gate} className="break-words">
                  <span className={g.pass ? "text-green-700" : "text-red-700"}>{g.pass ? "✓" : "✗"}</span> {g.gate} — {g.detail}
                </li>
              ))}
            </ul>
          </div>
        )}
        {d.coverage.length > 0 && (
          <div>
            <p className="font-semibold">Existing coverage</p>
            <ul className="mt-1 space-y-0.5">
              {d.coverage.map((c, i) => <li key={i} className="break-all">{c.kind} · {c.ref} · {c.state}</li>)}
            </ul>
          </div>
        )}
        <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr]">
          <dt className="font-semibold">Key</dt><dd className="break-all font-mono">{d.key}</dd>
          <dt className="font-semibold">Id</dt><dd className="break-all font-mono">{d.id}</dd>
          <dt className="font-semibold">Evidence ids</dt><dd className="break-all font-mono">{d.evidenceIds.length ? d.evidenceIds.join(", ") : "none"}</dd>
          <dt className="font-semibold">Order</dt><dd className="font-mono">[{d.order.join(", ")}]</dd>
          <dt className="font-semibold">First seen</dt><dd>{d.firstSeen ?? "—"}</dd>
          <dt className="font-semibold">Last seen</dt><dd>{d.lastSeen ?? "—"}</dd>
        </dl>
        {d.history.length > 0 && (
          <div>
            <p className="font-semibold">History</p>
            <ul className="mt-1 space-y-0.5">
              {d.history.map((h, i) => <li key={i}>{h.when} · {h.kind} · {h.actor}</li>)}
            </ul>
          </div>
        )}
        <details>
          <summary className="cursor-pointer text-muted-foreground">Raw report entry</summary>
          <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-card p-2 text-[11px] ring-1 ring-border">{JSON.stringify(d.raw, null, 2)}</pre>
        </details>
      </div>
    </details>
  );
}

// One opportunity. compact: a decision row (Needs Decision, Avoid).
export function OpportunityCard({ card, compact = false }: { card: Card; compact?: boolean }) {
  const facts = [
    card.keyword && (
      <span key="kw">
        “{card.keyword}”{card.intent ? <span className="text-muted-foreground"> · {card.intent}</span> : null}
      </span>
    ),
    !card.keyword && card.location && <span key="loc">{card.location}</span>,
    card.demand > 0 && <span key="demand">{card.demand.toLocaleString("en-US")} impressions (28 days)</span>,
    card.evidence > 0 && <span key="ev">{card.evidence} usable claim{card.evidence === 1 ? "" : "s"}</span>,
    card.eligibleFrom && <span key="elig">eligible from {card.eligibleFrom}</span>,
  ].filter(Boolean);

  return (
    <article
      id={card.anchor}
      data-key={card.key}
      className={cn("scroll-mt-24 min-w-0 rounded-xl bg-card ring-1 ring-border", compact ? "px-3 py-2.5" : "p-3.5 sm:p-4")}
    >
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <h4 className="min-w-0 flex-1 basis-48 break-words font-semibold text-navy-900">{card.topic}</h4>
        <span className="text-xs font-medium text-navy-700">{card.action}</span>
        {card.tier !== "none" && (
          <Badge variant="outline" className={cn("h-5 px-1.5 text-[11px]", tierStyles[card.tier])} aria-label={`Tier ${card.tier}`}>
            Tier {card.tier}
          </Badge>
        )}
        {card.lifecycle && card.lifecycle !== "open" && (
          <Badge variant="outline" className="h-5 px-1.5 text-[11px]">{card.lifecycle}</Badge>
        )}
      </div>
      <p className="mt-1 text-sm text-foreground/90">{card.reason}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <Target card={card} />
        {facts.length > 0 && (
          <span className="flex flex-wrap gap-x-3 gap-y-1 text-navy-700">{facts}</span>
        )}
        <Chips card={card} />
      </div>
      {card.blocker && (
        <p className="mt-2 border-l-2 border-amber-400 pl-2 text-xs text-amber-900">{card.blocker}</p>
      )}
      <Details card={card} />
    </article>
  );
}
