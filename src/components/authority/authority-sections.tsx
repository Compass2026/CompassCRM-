import type { AuthorityView, Group } from "@/lib/authority-view";
import { cn } from "@/lib/utils";
import { OpportunityCard } from "./opportunity-card";
import { toneStyles } from "./tones";

function GroupBlock({ group, compact }: { group: Group; compact: boolean }) {
  return (
    <details id={group.id} data-group={group.id} open={group.open} className="group/grp rounded-xl bg-muted/40 ring-1 ring-border">
      <summary className="flex cursor-pointer select-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2.5 text-sm">
        <span aria-hidden="true" className="text-muted-foreground transition-transform group-open/grp:rotate-90">▸</span>
        <span className="font-semibold text-navy-900">{group.label}</span>
        <span className="rounded-full bg-card px-2 py-0.5 text-xs font-semibold tabular-nums ring-1 ring-border" data-count>{group.count}</span>
        {group.note && <span className="text-xs text-muted-foreground">{group.note}</span>}
        {group.link && (
          <a href={`#${group.link.anchor}`} className="text-xs font-medium text-royal-600 hover:underline">
            Fix: {group.link.label}
          </a>
        )}
      </summary>
      <div className="space-y-2 px-2 pb-2 sm:px-3 sm:pb-3">
        {group.cards.map((c) => <OpportunityCard key={c.key} card={c} compact={compact} />)}
      </div>
    </details>
  );
}

export function AuthoritySections({ sections }: { sections: AuthorityView["sections"] }) {
  return (
    <div className="space-y-8">
      {sections.map((s) => {
        const tone = toneStyles[s.tone];
        const compact = s.section === "needs_decision" || s.section === "avoid";
        if (s.section === "avoid") {
          // Always collapsed: guidance, not work.
          return (
            <section key={s.section} id="section-avoid" aria-label="Avoid">
              {s.groups.map((g) => <GroupBlock key={g.id} group={{ ...g, label: "Avoid — do not target", open: false }} compact />)}
            </section>
          );
        }
        return (
          <section key={s.section} id={`section-${s.section}`} aria-labelledby={`h-${s.section}`} className="scroll-mt-24 space-y-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 id={`h-${s.section}`} className="flex items-center gap-2 text-lg font-bold tracking-tight text-navy-900">
                <span aria-hidden="true" className={cn("size-2.5 rounded-full", tone.dot)} />
                {s.label}
                <span className="text-base font-semibold tabular-nums text-muted-foreground">{s.count}</span>
              </h3>
              <p className="text-sm text-muted-foreground">{s.blurb}</p>
            </div>
            {s.groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing here.</p>
            ) : (
              <div className="space-y-2">
                {s.groups.map((g) => <GroupBlock key={g.id} group={g} compact={compact} />)}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
