import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, rankDelta } from "@/lib/portal";

type Row = {
  keyword: string;
  city: string | null;
  is_money: boolean;
  organic: number | null;
  organicPrev: number | null;
  map: number | null;
};

export default async function PortalRankingsPage() {
  const supabase = await createClient();
  const { data: rankings } = await supabase.from("portal_rankings").select("*");

  const byKeyword = new Map<string, Row>();
  for (const r of rankings ?? []) {
    const key = `${r.keyword}__${r.city ?? ""}`;
    const row: Row = byKeyword.get(key) ?? {
      keyword: r.keyword ?? "",
      city: r.city,
      is_money: r.is_money ?? false,
      organic: null,
      organicPrev: null,
      map: null,
    };
    if (r.result_type === "organic") {
      row.organic = r.position;
      row.organicPrev = r.previous_position;
    } else {
      row.map = r.position;
    }
    byKeyword.set(key, row);
  }

  // Money keywords first, then whoever ranks best; unranked at the bottom.
  const rows = [...byKeyword.values()].sort((a, b) => {
    if (a.is_money !== b.is_money) return a.is_money ? -1 : 1;
    return (a.organic ?? 999) - (b.organic ?? 999);
  });

  const checkedAt = (rankings ?? [])
    .map((r) => r.checked_at)
    .filter(Boolean)
    .sort()
    .at(-1);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title kicker mb-1">Rankings</h1>
        <p className="text-sm text-muted-foreground">
          Where you show up on Google, checked every week
          {checkedAt ? ` · last checked ${formatDate(checkedAt)}` : ""}.
        </p>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            The first rank check runs within a week of your keywords being set.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Search term</TableHead>
                  <TableHead>City</TableHead>
                  <TableHead className="text-right">Google</TableHead>
                  <TableHead className="text-right">Change</TableHead>
                  <TableHead className="text-right">Map results</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const delta = rankDelta(row.organic, row.organicPrev);
                  return (
                    <TableRow key={`${row.keyword}-${row.city ?? ""}`}>
                      <TableCell className="font-medium">
                        {row.keyword}
                        {row.is_money && (
                          <Badge
                            variant="outline"
                            className="ml-2 bg-orange-100 text-orange-800 border-orange-200"
                          >
                            priority
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.city ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.organic ?? "not in top 100"}
                      </TableCell>
                      <TableCell className="text-right">
                        {delta.direction === "up" && (
                          <span className="text-green-700">
                            ▲ {delta.amount}
                          </span>
                        )}
                        {delta.direction === "down" && (
                          <span className="text-red-700">▼ {delta.amount}</span>
                        )}
                        {delta.direction === "flat" && (
                          <span className="text-muted-foreground">—</span>
                        )}
                        {delta.direction === "new" && (
                          <span className="text-muted-foreground">new</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.map ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        &quot;Google&quot; is your position in the normal search results.
        &quot;Map results&quot; is your position in the map box that appears for
        local searches. Lower is better, and position 1–3 is the goal.
      </p>
    </div>
  );
}
