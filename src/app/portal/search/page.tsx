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
import { propertySearchTotals } from "@/lib/search-totals";

export default async function PortalSearchPage() {
  const supabase = await createClient();

  const { data: periods } = await supabase
    .from("portal_search_performance")
    .select("*")
    .order("period_end", { ascending: false });

  const latest = (periods ?? [])[0];
  // Headline figures are the website's Search Console totals from the
  // verified property import. The query rows below are a sample.
  const { data: measurements } = await supabase
    .from("portal_growth_measurements")
    .select("metric,scope,source,status,value,window_start,window_end,sequence")
    .in("metric", ["search_clicks", "search_impressions"])
    .order("sequence", { ascending: false })
    .limit(500);
  const totals = propertySearchTotals(measurements ?? []);
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
          How often your website appeared and was clicked in Google Search,
          and the searches behind it.
        </p>
      </div>

      {/* Property totals and the query sample come from independent imports:
          the totals card never depends on a sample existing. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {totals.state === "ok"
              ? `Your website in Google Search, ${formatDate(totals.start)} – ${formatDate(totals.end)}`
              : "Your website in Google Search"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {totals.state === "ok" ? (
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <div className="text-3xl font-heading font-semibold">
                  {formatNumber(totals.clicks)}
                </div>
                <div className="text-sm text-muted-foreground">
                  clicks from Google Search
                </div>
              </div>
              <div>
                <div className="text-3xl font-heading font-semibold">
                  {formatNumber(totals.impressions)}
                </div>
                <div className="text-sm text-muted-foreground">
                  times you appeared in results
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {totals.state === "several"
                ? "Search Console totals are reported separately for each of your websites; see Growth."
                : "Website totals are not available yet. Query samples are never shown as a total."}
            </p>
          )}
        </CardContent>
      </Card>

      {!latest ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Top searches</CardTitle>
          </CardHeader>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            No search sample yet. Google reports search detail about a month
            behind; it appears here after the next monthly sync.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Top searches</CardTitle>
              <p className="text-xs text-muted-foreground">
                {formatDate(latest.period_start)} – {formatDate(latest.period_end)}. A sample of
                the searches Search Console reported. It is not every search,
                and it does not add up to your totals.
              </p>
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
                <CardTitle className="text-base">Earlier search samples</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Clicks and appearances within the sampled searches only, not
                  website totals. Sample size varies between periods.
                </p>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Period</TableHead>
                      <TableHead className="text-right">Clicks in sample</TableHead>
                      <TableHead className="text-right">Appearances in sample</TableHead>
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
