import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createReportingConnections} from '../supabase/functions/reporting-connections/handler.ts';
test('inventory is admin-only and excludes credentials and raw errors',async()=>{
 let calls=0;
 const supabase={auth:{getUser:async()=>({data:{user:null}})},rpc:async()=>({data:'credential'})};
 const run=createReportingConnections({supabase,fetch:async(url)=>{calls++;return String(url).endsWith('/token')?Response.json({access_token:'private-token'}):Response.json({error:'private-provider-error'},{status:403});}});
 assert.equal((await run(new Request('https://test',{method:'POST'}))).status,401);assert.equal(calls,0);
 const result=await(await run(new Request('https://test',{method:'POST',headers:{'x-cron-secret':'credential'}}))).json();
 assert.equal(result.ga4.error,'provider_http_403');assert.doesNotMatch(JSON.stringify(result),/credential|private-token|private-provider-error/);
});
