import { createClient } from "@/lib/supabase/server";
import { loadGrowth, loadGrowthRankings } from "@/lib/growth-data";
import { growthRange } from "@/lib/client-growth";
import { ClientGrowthDashboard } from "@/components/client-growth-dashboard";

export default async function GrowthPage({params,searchParams}:{params:Promise<{clientId:string}>;searchParams:Promise<{range?:string;month?:string;start?:string;end?:string}>}) {
  const {clientId}=await params;
  const range=growthRange(await searchParams);
  const supabase=await createClient();
  const [data,rankings]=await Promise.all([loadGrowth(supabase,clientId),loadGrowthRankings(supabase,clientId)]);
  return <ClientGrowthDashboard {...data} {...rankings} range={range} action={`/clients/${clientId}/growth`} teamClientId={clientId}/>;
}
