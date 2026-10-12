import { createClient } from "@/lib/supabase/server";
import { loadGrowth } from "@/lib/growth-data";
import { growthRange } from "@/lib/client-growth";
import { ClientGrowthDashboard } from "@/components/client-growth-dashboard";

export default async function GrowthPage({params,searchParams}:{params:Promise<{clientId:string}>;searchParams:Promise<{range?:string;month?:string;start?:string;end?:string}>}) {
  const {clientId}=await params;
  const range=growthRange(await searchParams);
  const data=await loadGrowth(await createClient(),clientId);
  return <ClientGrowthDashboard {...data} range={range} action={`/clients/${clientId}/growth`} teamClientId={clientId}/>;
}
