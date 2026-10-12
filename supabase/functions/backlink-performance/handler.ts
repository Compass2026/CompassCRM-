import {websiteHost,summaryMetrics,historyMetrics} from './metrics.ts';
// deno-lint-ignore no-explicit-any
type Db=any;
export function createBacklinkPerformance({supabase,fetch:request=fetch,now=()=>new Date(),waitUntil}:{supabase:Db;fetch?:typeof fetch;now?:()=>Date;waitUntil?:(task:Promise<void>)=>void}) {
 const secret=async(name:string)=>(await supabase.rpc('get_secret',{secret_name:name})).data;
 return async(req:Request)=>{
  if(req.method!=='POST')return Response.json({error:'method_not_allowed'},{status:405});
  const cron=req.headers.get('x-cron-secret');
  if(!cron||cron!==await secret('SYNC_CRON_SECRET')) {
   const {data}=await supabase.auth.getUser((req.headers.get('Authorization')??'').replace(/^Bearer /i,''));
   if(!data?.user)return Response.json({error:'unauthorized'},{status:401});
   const {data:member}=await supabase.from('team_members').select('role').eq('auth_user_id',data.user.id).maybeSingle();
   if(member?.role!=='admin')return Response.json({error:'forbidden'},{status:403});
  }
  const body=await req.json().catch(()=>null);
  if(!body||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.client_id??''))return Response.json({error:'invalid_request'},{status:400});
  const {data:client,error}=await supabase.from('clients').select('id,status,website_url').eq('id',body.client_id).maybeSingle();
  if(error||!client||!['active','launching'].includes(client.status))return Response.json({error:'client_unavailable'},{status:404});
  const {data:brands,error:brandError}=await supabase.from('client_brand_workspaces').select('website_url').eq('client_id',client.id);
  if(brandError)return Response.json({error:'brands_unavailable'},{status:503});
  const hosts=[...new Set<string>([client,...(brands??[])].flatMap(b=>{try{return [websiteHost(b.website_url)];}catch{return [];}}))];
  if(!hosts.length)return Response.json({error:'website_required'},{status:422});
  const [login,password]=await Promise.all([secret('DATAFORSEO_LOGIN'),secret('DATAFORSEO_PASSWORD')]);
  if(!login||!password)return Response.json({error:'provider_connection_missing'},{status:424});
  const day=now().toISOString().slice(0,10),end=new Date(day.slice(0,7)+'-01T00:00:00Z');end.setUTCDate(0);
  const start=new Date(end);start.setUTCDate(1);start.setUTCMonth(start.getUTCMonth()-1);
  const from=start.toISOString().slice(0,10),to=end.toISOString().slice(0,10);
  const results:Record<string,unknown>[]=[];
  const execute=async()=>{
   for(const host of hosts) {
    const lease=await supabase.rpc('backlink_sync_claim',{p_client_id:client.id,p_host:host});
    if(lease.error){results.push({host,status:'failed',code:'claim_failed'});continue;}
    if(!lease.data?.id){results.push({host,status:'unchanged'});continue;}
    const runId=lease.data.id,receipt:Record<string,unknown>[]=[];let failed=false;
    const read=async(kind:string,options:Record<string,unknown>)=>{
     const response=await request(`https://api.dataforseo.com/v3/backlinks/${kind}/live`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Basic '+btoa(`${login}:${password}`),'Content-Type':'application/json'},body:JSON.stringify([{target:host,...options}])});
     if(!response.ok)throw new Error(`provider_http_${response.status}`);return response.json();
    };
    try {
     const metrics=summaryMetrics(await read('summary',{include_subdomains:true,include_indirect_links:true,exclude_internal_backlinks:true,backlinks_status_type:'live'}),host);
     const saved=await supabase.rpc('backlink_profile_record',{p_run_id:runId,p_kind:'summary',p_start:day,p_end:day,p_data:metrics});
     if(saved.error)throw new Error('import_write_failed');receipt.push({kind:'summary',...saved.data,cost:metrics.cost});
    }catch(e){failed=true;receipt.push({kind:'summary',status:'failed',code:errorCode(e)});}
    try {
     const metrics=historyMetrics(await read('timeseries_new_lost_summary',{include_subdomains:true,group_range:'month',date_from:from,date_to:to}),host);
     for(const month of metrics.months) {
      const saved=await supabase.rpc('backlink_profile_record',{p_run_id:runId,p_kind:'history',p_start:month.start,p_end:month.end,p_data:{task_id:metrics.task_id,values:month.values}});
      if(saved.error)throw new Error('import_write_failed');receipt.push({kind:'history',month:month.start,...saved.data});
     }
     receipt.push({kind:'history_cost',cost:metrics.cost});
    }catch(e){failed=true;receipt.push({kind:'history',status:'failed',code:errorCode(e)});}
    const log=await supabase.from('backlink_profile_sync_runs').update({status:failed?'partial':'completed',results:receipt,finished_at:now().toISOString()}).eq('id',runId);
    results.push({host,run_id:runId,status:log.error?'failed':failed?'partial':'completed',results:receipt});
   }
  };
  if(waitUntil){waitUntil(execute());return Response.json({status:'started',client_id:client.id},{status:202});}
  await execute();return Response.json({results});
 };
}
function errorCode(e:unknown){const m=e instanceof Error?e.message:'';return /^(provider_http_\d{3}|provider_result_failed|response_identity_mismatch|invalid_metrics|incomplete_history|import_write_failed)$/.test(m)?m:'import_failed';}
