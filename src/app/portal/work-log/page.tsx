import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, formatMonth, workLabel } from "@/lib/portal";

export default async function PortalWorkLogPage() {
  const supabase = await createClient();
  const { data: work } = await supabase
    .from("portal_work_log")
    .select("*")
    .order("at", { ascending: false, nullsFirst: false });

  // Group by month so a client reads it as "what happened in September".
  const months = new Map<string, typeof work>();
  for (const row of work ?? []) {
    const key = row.at ? row.at.slice(0, 7) : "undated";
    months.set(key, [...(months.get(key) ?? []), row]);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title kicker mb-1">What we&apos;ve done</h1>
        <p className="text-sm text-muted-foreground">
          Every change we published for you, newest first.
        </p>
      </div>

      {(work ?? []).length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Work appears here as soon as it is published.
          </CardContent>
        </Card>
      ) : (
        [...months.entries()].map(([month, rows]) => (
          <Card key={month}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                {month === "undated" ? "Earlier" : formatMonth(`${month}-01`)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {(rows ?? []).map((row, i) => (
                  <li key={i} className="flex justify-between gap-4">
                    <span>
                      {row.url ? (
                        <a
                          href={row.url}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          {workLabel(row.kind, row.label)}
                        </a>
                      ) : (
                        workLabel(row.kind, row.label)
                      )}
                    </span>
                    <span className="text-muted-foreground whitespace-nowrap">
                      {formatDate(row.at)}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
