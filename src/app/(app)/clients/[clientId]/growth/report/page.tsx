import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadKeywordReport } from "@/lib/keyword-report-data";
import { KeywordReport } from "@/components/keyword-report";

// Team-only pilot report. Reads stored records; never calls a provider.
export default async function KeywordReportPage({params}:{params:Promise<{clientId:string}>}) {
  const {clientId}=await params;
  const now=new Date().toISOString();
  const {data,error}=await loadKeywordReport(await createClient(),clientId,now);
  if(error==="not_found") notFound();
  if(error||!data) return <div className="surface p-5"><h2 className="font-semibold">Keyword results report</h2><p role="alert" className="mt-2 text-sm">{error}</p></div>;
  return <KeywordReport data={data} now={now} clientId={clientId}/>;
}
