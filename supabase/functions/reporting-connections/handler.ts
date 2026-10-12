// Read-only account discovery. Credentials and provider error payloads never leave this boundary.
// deno-lint-ignore no-explicit-any
type Db = any;
export function createReportingConnections({supabase,fetch:request=fetch}:{supabase:Db;fetch?:typeof fetch}) {
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
  const read=async(url:string,init:RequestInit={})=>{const r=await request(url,{...init,redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error(`provider_http_${r.status}`);return r.json();};
  const output:Record<string,unknown>={checked_at:new Date().toISOString()};
  try {
   const [clientId,clientSecret,refresh]=await Promise.all([secret('GSC_CLIENT_ID'),secret('GSC_CLIENT_SECRET'),secret('GOOGLE_OPS_REFRESH_TOKEN')]);
   if(!clientId||!clientSecret||!refresh)throw new Error('connection_missing');
   const token=await read('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refresh,grant_type:'refresh_token'})});
   if(!token.access_token)throw new Error('connection_missing');
   const headers={Authorization:`Bearer ${token.access_token}`};
   try {
    const properties:unknown[]=[];let pageToken='';
    for(let page=0;page<10;page++) {
     const inventory=await read(`https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200${pageToken?'&pageToken='+encodeURIComponent(pageToken):''}`,{headers});
     for(const a of inventory.accountSummaries??[])for(const p of a.propertySummaries??[]) {
      if(!/^properties\/\d+$/.test(p.property))continue;
      const streams:unknown[]=[];let next='';
      for(let i=0;i<10;i++) {
       const s=await read(`https://analyticsadmin.googleapis.com/v1beta/${p.property}/dataStreams?pageSize=200${next?'&pageToken='+encodeURIComponent(next):''}`,{headers});
       for(const stream of s.dataStreams??[])if(stream.webStreamData)streams.push({name:stream.name,url:stream.webStreamData.defaultUri,measurement_id:stream.webStreamData.measurementId});
       next=s.nextPageToken??'';if(!next)break;if(i===9)throw new Error('inventory_limit');
      }
      properties.push({account:a.account,account_name:a.displayName,property:p.property,name:p.displayName,streams});
     }
     pageToken=inventory.nextPageToken??'';if(!pageToken)break;if(page===9)throw new Error('inventory_limit');
    }
    output.ga4={properties};
   }catch(e){output.ga4={error:code(e)};}
   try {const sites=await read('https://www.googleapis.com/webmasters/v3/sites',{headers});output.gsc={sites:sites.siteEntry??[]};}catch(e){output.gsc={error:code(e)};}
  }catch(e){output.google={error:code(e)};}
  return Response.json(output);
 };
}
function code(e:unknown){const m=e instanceof Error?e.message:'';return /^(provider_http_\d{3}|connection_missing|inventory_limit)$/.test(m)?m:'inventory_failed';}
