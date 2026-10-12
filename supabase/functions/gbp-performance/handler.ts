import {completeMonths, METRICS, normalizePerformance} from "./metrics.ts";
// Dependency injection keeps provider requests and database writes testable.
// deno-lint-ignore no-explicit-any
type Client = any;
const locationId=(value:unknown)=>typeof value==="string" && /^(?:locations\/)?[0-9]{1,30}$/.test(value) ? `locations/${value.replace(/^locations\//,"")}` : null;
type Binding = {client_id:string;publish_account_id:string;publish_page_id:string;external_account_id:string};
export function createGbpPerformance({supabase,fetch:request=fetch,now=()=>new Date(),waitUntil}: {supabase:Client;fetch?:typeof fetch;now?:()=>Date;waitUntil?:(task:Promise<void>)=>void}) {
  const secret=async(name:string)=>{const r=await supabase.rpc("get_secret",{secret_name:name});return r.error?null:r.data;};
  return async (req:Request):Promise<Response> => {
    if(req.method!=="POST") return Response.json({error:"method_not_allowed"},{status:405});
    const cron=req.headers.get("x-cron-secret");
    if(!cron || cron!==await secret("SYNC_CRON_SECRET")) {
      const {data}=await supabase.auth.getUser(req.headers.get("Authorization")?.replace(/^Bearer /i,"")??"");
      if(!data?.user) return Response.json({error:"unauthorized"},{status:401});
      const {data:member}=await supabase.from("team_members").select("role").eq("auth_user_id",data.user.id).maybeSingle();
      if(member?.role!=="admin") return Response.json({error:"forbidden"},{status:403});
    }
    const body=await req.json().catch(()=>null);
    if(!body || (body.client_id!==undefined && !/^[0-9a-f-]{36}$/i.test(body.client_id)) || (body.months!==undefined && (!Number.isInteger(body.months)||body.months<1||body.months>12))) return Response.json({error:"invalid_request"},{status:400});
    const key=await secret("ZERNIO_READ_API_KEY");
    if(!key) return Response.json({error:"read_key_missing"},{status:424});
    let query=supabase.from("social_accounts").select("client_id,publish_account_id,publish_page_id,external_account_id,clients!inner(status)").eq("platform","google_business").eq("publish_provider","zernio").in("clients.status",["active","launching"]);
    if(body.client_id) query=query.eq("client_id",body.client_id);
    const {data:bindings,error}=await query;
    if(error) return Response.json({error:"bindings_unavailable"},{status:503});
    const runId=crypto.randomUUID();
    const started=await supabase.from("gbp_performance_sync_runs").insert({id:runId,status:"running",results:[]});
    if(started.error) return Response.json({error:"sync_log_failed"},{status:503});
    const results:Record<string,unknown>[]=[];
    const get=async(path:string,params:Record<string,string>={})=>{
      const url=new URL(`https://zernio.com/api${path}`);for(const [k,v] of Object.entries(params)) url.searchParams.set(k,v);
      const res=await request(url,{method:"GET",redirect:"error",headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(20000)});
      if(!res.ok) throw new Error(`provider_http_${res.status}`);
      return res.json();
    };
    const execute=async()=>{
    for(const b of (bindings??[]) as Binding[]) {
      let period:string|null=null;
      try {
        if(!/^[0-9a-f]{24}$/.test(b.publish_account_id??"") || !/^locations\/[0-9]{1,30}$/.test(b.publish_page_id??"") || b.publish_page_id!==b.external_account_id) throw new Error("binding_incomplete");
        const location=await get(`/v1/accounts/${b.publish_account_id}/gmb-locations`);
        if(locationId(location.selectedLocationId)!==b.publish_page_id) throw new Error("location_changed");
        for(const window of completeMonths(body.months??3,now())) {
          period=window.start;
          try {
          const raw=await get("/v1/analytics/googlebusiness/performance",{accountId:b.publish_account_id,fromDate:window.start,toDate:window.end,metrics:METRICS.join(",")});
          const normalized=normalizePerformance(raw,b.publish_account_id,window.start,window.end);
          // Check the remote destination again before committing a response.
          const after=await get(`/v1/accounts/${b.publish_account_id}/gmb-locations`);
          if(locationId(after.selectedLocationId)!==b.publish_page_id) throw new Error("location_changed");
          const saved=await supabase.rpc("gbp_performance_record",{p_client_id:b.client_id,p_account_id:b.publish_account_id,p_location_id:b.publish_page_id,p_start:window.start,p_end:window.end,p_data:normalized});
          if(saved.error) throw new Error("import_write_failed");
          results.push({client_id:b.client_id,month:window.start,...saved.data});
          } catch(e) {
            recordFailure(b,period,e);
            if(e instanceof Error && /^(location_changed|provider_http_(401|402|403|429))$/.test(e.message)) break;
          }

        }
      } catch(e) {
        recordFailure(b,period,e);
      }
    }
    const status=results.some(r=>r.status==="failed")?"partial":"completed";
    const log=await supabase.from("gbp_performance_sync_runs").update({status,results,finished_at:now().toISOString()}).eq("id",runId);
    if(log.error) console.error("gbp_performance_sync_log_failed",runId);
    };
    function recordFailure(b:Binding,period:string|null,e:unknown) {
      const message=e instanceof Error?e.message:"import_failed";
      const code=/^(provider_http_\d{3}|binding_incomplete|location_changed|response_identity_mismatch|incomplete_metric_days|invalid_metric_day|metric_total_mismatch|import_write_failed)$/.test(message)?message:"import_failed";
      results.push({client_id:b.client_id,month:period,status:"failed",code});
    }
    if(waitUntil) {waitUntil(execute());return Response.json({status:"started",run_id:runId},{status:202});}
    await execute();
    return Response.json({status:results.some(r=>r.status==="failed")?"partial":"completed",run_id:runId,results});
  };
}
