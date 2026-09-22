import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMonth, formatNumber } from "@/lib/portal";

type Summary = {
  wins?: string[];
  gsc?: { clicks?: number; impressions?: number };
  ranks?: { tracked?: number; up?: number; top3?: number; top10?: number };
};

export default async function PortalReportsPage() {
  const supabase = await createClient();
  const { data: reports } = await supabase
    .from("portal_reports")
    .select("*")
    .order("period", { ascending: false });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title kicker mb-1">Reports</h1>
        <p className="text-sm text-muted-foreground">
          A summary of the month, published at the start of the next one.
        </p>
      </div>

      {(reports ?? []).length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Your first monthly report arrives at the start of next month.
          </CardContent>
        </Card>
      ) : (
        (reports ?? []).map((report) => {
          const summary = (report.summary ?? null) as Summary | null;
          return (
            <Card key={report.period}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {formatMonth(report.period)}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {summary?.gsc && (
                  <div className="flex gap-8">
                    <div>
                      <div className="text-xl font-heading font-semibold">
                        {formatNumber(summary.gsc.clicks ?? null)}
                      </div>
                      <div className="text-muted-foreground">
                        visits from Google
                      </div>
                    </div>
                    {summary.ranks?.top10 != null && (
                      <div>
                        <div className="text-xl font-heading font-semibold">
                          {formatNumber(summary.ranks.top10)}
                        </div>
                        <div className="text-muted-foreground">
                          keywords in the top 10
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {summary?.wins && summary.wins.length > 0 && (
                  <ul className="list-disc pl-5 space-y-1">
                    {summary.wins.map((win, i) => (
                      <li key={i}>{win}</li>
                    ))}
                  </ul>
                )}
                {report.report_url && (
                  <a
                    href={report.report_url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    Read the full report
                  </a>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
