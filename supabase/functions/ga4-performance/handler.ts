import {GA4_METRICS,reportingPeriods,normalizeGa4,websiteHost} from "./metrics.ts";
// deno-lint-ignore no-explicit-any
type Client=any;
export function createGa4Performance({supabase,fetch:request=fetch,now=()=>new Date(),waitUntil}:{supabase:Client;fetch?:typeof fetch;now?:()=>Date;waitUntil?:(task:Promise<void>)=>void}) {
 const secret=async(name:string)=>{const r=await supabase.rpc("get_secret",{secret_name:name});return r.error?null:r.data;};
 return async(req:Request):Promise<Response>=>{
  if(req.method!=="POST")return Response.json({error:"method_not_allowed"},{status:405});
  const cron=req.headers.get("x-cron-secret");
  if(!cron||cron!==await secret("SYNC_CRON_SECRET")) {
   const {data}=await supabase.auth.getUser(req.headers.get("Authorization")?.replace(/^Bearer /i,"")??"");
   if(!data?.user)return Response.json({error:"unauthorized"},{status:401});
   const {data:member}=await supabase.from("team_members").select("role").eq("auth_user_id",data.user.id).maybeSingle();
   if(member?.role!=="admin")return Response.json({error:"forbidden"},{status:403});
  }
  const body=await req.json().catch(()=>null);
  if(!body||typeof body.client_id!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.client_id)||(body.months!==undefined&&(!Number.isInteger(body.months)||body.months<1||body.months>6)))return Response.json({error:"invalid_request"},{status:400});
  const {data:client,error}=await supabase.from("clients").select("id,status,ga4_property,website_url").eq("id",body.client_id).maybeSingle();
  if(error||!client)return Response.json({error:"client_unavailable"},{status:404});
  if(!["active","launching"].includes(client.status)||!/^properties\/\d+$/.test(client.ga4_property??"")||!client.website_url)return Response.json({error:"property_binding_required"},{status:422});
  const credentials=await Promise.all([secret("GOOGLE_OPS_CLIENT_ID").then(async v=>v??await secret("GSC_CLIENT_ID")),secret("GOOGLE_OPS_CLIENT_SECRET").then(async v=>v??await secret("GSC_CLIENT_SECRET")),secret("GOOGLE_OPS_REFRESH_TOKEN")]);
  if(credentials.some(v=>!v))return Response.json({error:"google_connection_missing"},{status:424});
  const runId=crypto.randomUUID();
  const started=await supabase.from("ga4_performance_sync_runs").insert({id:runId,client_id:client.id,status:"running",results:[]});
  if(started.error)return Response.json({error:"sync_log_failed"},{status:503});
  const results:Record<string,unknown>[]=[];
  const read=async(url:string,init:RequestInit)=>{
   const response=await request(url,{...init,redirect:"error",signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw new Error(`google_http_${response.status}`);
   return response.json();
  };
  const execute=async()=>{
   try {
    const token=await read("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:credentials[0],client_secret:credentials[1],refresh_token:credentials[2],grant_type:"refresh_token"})});
    if(typeof token.access_token!=="string"||!token.access_token)throw new Error("google_token_failed");
    const headers={Authorization:`Bearer ${token.access_token}`,"Content-Type":"application/json"};
    const host=websiteHost(client.website_url);
    const metadata=await read(`https://analyticsadmin.googleapis.com/v1beta/${client.ga4_property}`,{method:"GET",headers});
    if(metadata.name!==client.ga4_property||!metadata.timeZone||!metadata.createTime)throw new Error("property_access_missing");
    let matched=false,pageToken="";
    for(let page=0;page<10;page++) {
     const inventory=await read(`https://analyticsadmin.googleapis.com/v1beta/${client.ga4_property}/dataStreams?pageSize=200${pageToken?`&pageToken=${encodeURIComponent(pageToken)}`:""}`,{method:"GET",headers});
     matched ||= (inventory.dataStreams??[]).some((s:{webStreamData?:{defaultUri?:string}})=>{try{return websiteHost(s.webStreamData?.defaultUri??"")===host;}catch{return false;}});
     pageToken=inventory.nextPageToken??"";if(!pageToken)break;
    }
    if(!matched)throw new Error("property_binding_mismatch");
    for(const period of reportingPeriods(body.months??3,now(),metadata.timeZone,metadata.createTime)) {
     try {
      const raw=await read(`https://analyticsdata.googleapis.com/v1beta/${client.ga4_property}:runReport`,{method:"POST",headers,body:JSON.stringify({dateRanges:[{startDate:period.start,endDate:period.end}],metrics:Object.keys(GA4_METRICS).map(name=>({name})),dimensionFilter:{filter:{fieldName:"hostName",inListFilter:{values:[host,`www.${host}`],caseSensitive:false}}},limit:"1"})});
      const data=normalizeGa4(raw,metadata.timeZone,host,period.coverage);
      const saved=await supabase.rpc("ga4_performance_record",{p_client_id:client.id,p_property:client.ga4_property,p_start:period.start,p_end:period.end,p_data:data});
      if(saved.error)throw new Error("import_write_failed");
      results.push({month:period.start,...saved.data});
     }catch(e){fail(period.start,e);if(e instanceof Error&&/^(import_write_failed|google_http_(401|403|429))$/.test(e.message))break;}
    }
   }catch(e){fail(null,e);}
   const log=await supabase.from("ga4_performance_sync_runs").update({status:results.some(r=>r.status==="failed")?"partial":"completed",results,finished_at:now().toISOString()}).eq("id",runId);
   if(log.error)console.error("ga4_performance_sync_log_failed",runId);
  };
  function fail(month:string|null,e:unknown){const message=e instanceof Error?e.message:"import_failed";results.push({month,status:message==="no_reported_data"?"no_data":"failed",code:/^(google_http_\d{3}|google_token_failed|property_access_missing|property_binding_mismatch|timezone_mismatch|incomplete_report|invalid_website|no_reported_data|unexpected_dimensions|invalid_metrics|import_write_failed)$/.test(message)?message:"import_failed"});}
  if(waitUntil){waitUntil(execute());return Response.json({status:"started",run_id:runId},{status:202});}
  await execute();return Response.json({run_id:runId,results});
 };
}
