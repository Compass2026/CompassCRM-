import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadGrowth, loadGrowthRankings, loadGrowthWork } from "@/lib/growth-data";
import { growthRange } from "@/lib/client-growth";
import { ClientGrowthDashboard } from "@/components/client-growth-dashboard";

export default async function PortalGrowthPage({searchParams}:{searchParams:Promise<{range?:string;month?:string;start?:string;end?:string}>}) {
  const supabase=await createClient();
  const {data:client}=await supabase.from("portal_client").select("id").maybeSingle();
  if(!client?.id) notFound();
  const [data,rankings,work]=await Promise.all([loadGrowth(supabase,client.id,true),loadGrowthRankings(supabase,client.id,true),loadGrowthWork(supabase,client.id,true)]);
  return <ClientGrowthDashboard {...data} {...rankings} {...work} range={growthRange(await searchParams)} action="/portal/growth"/>;
}
