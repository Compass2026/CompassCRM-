import { Badge } from "@/components/ui/badge";
import type { HistoryRow } from "@/lib/authority-view";
import { cn } from "@/lib/utils";
import { runStatusStyles } from "./tones";

function Status({ row }: { row: HistoryRow }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge variant="outline" className={cn("h-5 px-1.5 text-[11px]", runStatusStyles[row.status])}>{row.status}</Badge>
      {row.current && <Badge className="h-5 px-1.5 text-[11px]">current</Badge>}
    </span>
  );
}

export function AuthorityRunHistory({ rows }: { rows: HistoryRow[] }) {
  return (
    <section aria-labelledby="h-history" className="space-y-3">
      <h3 id="h-history" className="text-lg font-bold tracking-tight text-navy-900">Run history</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl ring-1 ring-border md:block">
            <table className="w-full text-left text-sm" data-history="table">
              <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-semibold">When</th>
                  <th className="px-3 py-2 font-semibold">Mode</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">By</th>
                  <th className="px-3 py-2 font-semibold">Changes</th>
                  <th className="px-3 py-2 font-semibold">Inventory</th>
                  <th className="px-3 py-2 font-semibold">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y bg-card">
                {rows.map((r) => (
                  <tr key={r.id} data-run={r.id} data-status={r.status} className={cn(r.current && "bg-green-50/50")}>
                    <td className="whitespace-nowrap px-3 py-2">{r.when}</td>
                    <td className="px-3 py-2">{r.mode}</td>
                    <td className="px-3 py-2"><Status row={r} /></td>
                    <td className="px-3 py-2">{r.by}</td>
                    <td className="px-3 py-2">{r.changes}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{r.inventory}</td>
                    <td className="max-w-72 px-3 py-2 text-xs text-muted-foreground">{r.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-2 md:hidden" data-history="cards">
            {rows.map((r) => (
              <li key={r.id} data-run={r.id} data-status={r.status} className={cn("rounded-xl bg-card p-3 text-sm ring-1 ring-border", r.current && "ring-green-300")}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">{r.when} · {r.mode}</span>
                  <Status row={r} />
                </div>
                <p className="mt-1">{r.changes} <span className="text-muted-foreground">· {r.by}</span></p>
                <p className="mt-0.5 text-xs text-muted-foreground">{r.inventory}</p>
                {r.note && <p className="mt-0.5 break-words text-xs text-muted-foreground">{r.note}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
