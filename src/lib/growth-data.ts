import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { GrowthMeasurement, SearchHistory } from "./client-growth.ts";
import type { BacklinkCheck, BacklinkOpportunity, PortalBacklink } from "./backlinks.ts";

// Explicit columns keep internal commentary and evidence out of the shared UI.
const columns="id,client_id,sequence,metric,scope,source,platform,channel,context,report_period,window_start,window_end,status,value,created_at";
export async function loadGrowth(supabase:SupabaseClient<Database>,clientId:string,portal=false) {
  const rows:GrowthMeasurement[]=[];
  for(let offset=0;offset<20000;offset+=500) {
    const query=portal ? supabase.from("portal_growth_measurements").select(columns).eq("client_id",clientId) : supabase.from("report_measurements").select(columns).eq("client_id",clientId);
    const {data,error}=await query.order("sequence").range(offset,offset+499);
    if(error) return {rows:[],error:"Progress measurements could not be loaded. Please retry.",search:[] as SearchHistory[],searchError:null as string|null};
    rows.push(...(data??[]) as GrowthMeasurement[]);
    if((data?.length??0)<500) {
      const {data:search,error:searchError}=await supabase.from(portal?"portal_growth_search":"client_growth_search").select("*").eq("client_id",clientId).order("period_end").limit(1000);
      return {rows,error:null,search:(search??[]) as SearchHistory[],searchError:searchError?"Search history could not be loaded.":search?.length===1000?"Search history exceeds this dashboard's limit; ask Compass to review the complete history.":null};
    }
  }
  return {rows:[],error:"Progress history exceeds the current limit. Ask Compass to review the complete history.",search:[] as SearchHistory[],searchError:null as string|null};
}
export async function loadBacklinks(supabase:SupabaseClient<Database>,clientId:string) {
  const opportunities:BacklinkOpportunity[]=[];
  for(let offset=0;offset<10000;offset+=500) {
    const {data,error}=await supabase.from("backlink_opportunities").select("*").eq("client_id",clientId).order("created_at").order("id").range(offset,offset+499);
    if(error) return {opportunities:[],checks:[],error:"Backlink opportunities could not be loaded."};
    opportunities.push(...(data??[]) as BacklinkOpportunity[]);
    if((data?.length??0)<500) {
      const checks:BacklinkCheck[]=[];
      // Chunk ids and page checks to avoid silently losing the oldest live date.
      for(let chunk=0;chunk<opportunities.length;chunk+=100) {
        for(let page=0;page<20000;page+=500) {
          const {data:history,error:historyError}=await supabase.from("backlink_checks").select("*").in("opportunity_id",opportunities.slice(chunk,chunk+100).map(o=>o.id)).order("recorded_at").order("id").range(page,page+499);
          if(historyError) return {opportunities:[],checks:[],error:"Link check history could not be loaded."};
          checks.push(...(history??[]) as BacklinkCheck[]);
          if((history?.length??0)<500) break;
          if(page===19500) return {opportunities:[],checks:[],error:"Link check history exceeds the current limit."};
        }
      }
      return {opportunities,checks,error:null};
    }
  }
  return {opportunities:[],checks:[],error:"Backlink history exceeds the current limit."};
}
export async function loadPortalBacklinks(supabase:SupabaseClient<Database>,clientId:string) {
  const rows:PortalBacklink[]=[];
  for(let offset=0;offset<10000;offset+=500) {
    const {data,error}=await supabase.from("portal_backlinks").select("*").eq("client_id",clientId).order("id").range(offset,offset+499);
    if(error) return {rows:[],error:"Backlinks could not be loaded. Please retry."};
    rows.push(...(data??[]) as PortalBacklink[]);
    if((data?.length??0)<500) return {rows,error:null};
  }
  return {rows:[],error:"Backlink history exceeds the current limit."};
}
