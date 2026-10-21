import { createClient } from "@/lib/supabase/server";
import { loadGrowth, loadGrowthRankings, loadGrowthWork } from "@/lib/growth-data";
import { growthRange } from "@/lib/client-growth";
import Link from "next/link";
import { ClientGrowthDashboard } from "@/components/client-growth-dashboard";

export default async function GrowthPage({params,searchParams}:{params:Promise<{clientId:string}>;searchParams:Promise<{range?:string;month?:string;start?:string;end?:string}>}) {
  const {clientId}=await params;
  const range=growthRange(await searchParams);
  const supabase=await createClient();
  const [data,rankings,work]=await Promise.all([loadGrowth(supabase,clientId),loadGrowthRankings(supabase,clientId),loadGrowthWork(supabase,clientId)]);
  return <div className="space-y-4">
    <Link href={`/clients/${clientId}/growth/report`} className="inline-flex rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-navy-900">Keyword results report (pilot)</Link>
    <ClientGrowthDashboard {...data} {...rankings} {...work} range={range} action={`/clients/${clientId}/growth`} teamClientId={clientId}/>
  </div>;
}
