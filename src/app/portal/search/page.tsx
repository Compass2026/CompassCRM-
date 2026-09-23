import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatNumber } from "@/lib/portal";

export default async function PortalSearchPage() {
  const supabase = await createClient();

  const { data: periods } = await supabase
    .from("portal_search_performance")
    .select("*")
    .order("period_end", { ascending: false });

  const latest = (periods ?? [])[0];
  const { data: queries } = latest
    ? await supabase
        .from("portal_search_queries")
        .select("query, clicks, impressions, avg_position")
        .eq("period_start", latest.period_start ?? "")
        .order("clicks", { ascending: false })
        .limit(25)
    : { data: [] };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title kicker mb-1">Search traffic</h1>
        <p className="text-sm text-muted-foreground">
          What people searched for on Google before landing on your site.
        </p>
      </div>

      {!latest ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Google reports this data about a month behind. Yours will appear
            after the next monthly sync.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                {formatDate(latest.period_start)} – {formatDate(latest.period_end)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-6 sm:grid-cols-3">
                <div>
                  <div className="text-3xl font-heading font-semibold">
                    {formatNumber(latest.clicks)}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    visits from Google
                  </div>
                </div>
                <div>
                  <div className="text-3xl font-heading font-semibold">
                    {formatNumber(latest.impressions)}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    times you appeared in results
                  </div>
                </div>
                <div>
                  <div className="text-3xl font-heading font-semibold">
                    {latest.avg_position ?? "—"}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    average position
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Top searches</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Search</TableHead>
                    <TableHead className="text-right">Visits</TableHead>
                    <TableHead className="text-right">Appearances</TableHead>
                    <TableHead className="text-right">Avg. position</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(queries ?? []).map((q, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium">{q.query}</TableCell>
                      <TableCell className="text-right">
                        {formatNumber(q.clicks)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatNumber(q.impressions)}
                      </TableCell>
                      <TableCell className="text-right">
                        {q.avg_position ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {(periods ?? []).length > 1 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Earlier periods</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Period</TableHead>
                      <TableHead className="text-right">Visits</TableHead>
                      <TableHead className="text-right">Appearances</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(periods ?? []).slice(1).map((p, i) => (
                      <TableRow key={i}>
                        <TableCell>
                          {formatDate(p.period_start)} – {formatDate(p.period_end)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatNumber(p.clicks)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatNumber(p.impressions)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
