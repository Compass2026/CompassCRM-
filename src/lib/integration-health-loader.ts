import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { completeRead, integrationEvidence, reportingHost, type IntegrationBinding, type IntegrationSource } from "./integration-health.ts";

export async function loadIntegrationHealth(db: SupabaseClient<Database>, clientIds: string[], now: string) {
  if (!clientIds.length) return [];
  // Only safe identifiers/outcomes are read. No provider tokens, raw response
  // bodies, Vault reads, service-role access, or writes from the dashboard.
  const [clients,brands,accounts,gscImports,ga4Imports,gbpImports,gscRuns,ga4Runs,gbpRuns] = await Promise.all([
    db.from("clients").select("id,name,website_url,gsc_property,ga4_property",{count:"exact"}).in("id",clientIds).limit(3000),
    db.from("client_brand_workspaces").select("id,client_id,name,website_url,gsc_property,ga4_property",{count:"exact"}).in("client_id",clientIds).limit(3000),
    db.from("social_accounts").select("client_id,publish_account_id,publish_page_id,external_account_id",{count:"exact"}).in("client_id",clientIds).eq("platform","google_business").eq("publish_provider","zernio").limit(3000),
    db.from("gsc_performance_imports").select("id,client_id,property,period,period_end,created_at",{count:"exact"}).in("client_id",clientIds).limit(3000),
    db.from("ga4_performance_imports").select("id,client_id,property,period,period_end,created_at,host:data->>host",{count:"exact"}).in("client_id",clientIds).limit(3000),
    db.from("gbp_performance_imports").select("id,client_id,account_id,location_id,period,period_end,created_at",{count:"exact"}).in("client_id",clientIds).limit(3000),
    db.from("gsc_performance_sync_runs").select("id,client_id,created_at,finished_at,status,results",{count:"exact"}).in("client_id",clientIds).limit(3000),
    db.from("ga4_performance_sync_runs").select("id,client_id,created_at,finished_at,status,results",{count:"exact"}).in("client_id",clientIds).limit(3000),
    db.from("gbp_performance_sync_runs").select("id,created_at,finished_at,status,results",{count:"exact"}).limit(3000),
  ]);
  const c=completeRead(clients), b=completeRead(brands), a=completeRead(accounts);
  function googleBindings(source: "gsc" | "ga4"): IntegrationBinding[] | null {
    if (c===null || b===null) return null;
    const key=source === "gsc" ? "gsc_property" : "ga4_property";
    return c.flatMap(client=>{
      const brands=b!.filter(brand=>brand.client_id===client.id);
      const rows: IntegrationBinding[]=brands.map(brand=>({clientId:client.id,label:brand.name,property:brand[key] ?? "",brandId:brand.id,host:reportingHost(brand.website_url)}));
      if (!brands.length || (client[key] && !brands.some(brand=>brand[key]===client[key])))
        rows.push({clientId:client.id,label:brands.length ? client.name+" (parent website)" : client.name,property:client[key] ?? "",brandId:undefined,host:reportingHost(client.website_url)});
      return rows;
    });
  }
  const bindings={gsc:googleBindings("gsc"),ga4:googleBindings("ga4"),gbp:a===null ? null : a.filter(r=>
    /^[0-9a-f]{24}$/.test(r.publish_account_id ?? "") && /^locations\/[0-9]{1,30}$/.test(r.publish_page_id ?? "") && r.publish_page_id===r.external_account_id)
    .map(r=>({clientId:r.client_id,label:"Shared client GBP",property:r.publish_page_id!,accountId:r.publish_account_id!}))};
  const input={bindings,imports:{gsc:completeRead(gscImports),ga4:completeRead(ga4Imports),gbp:completeRead(gbpImports)},runs:{gsc:completeRead(gscRuns),ga4:completeRead(ga4Runs),gbp:completeRead(gbpRuns)}};
  return clientIds.flatMap(id=>(["gsc","ga4","gbp"] as IntegrationSource[]).map(source=>integrationEvidence(input,id,source,now)));
}
