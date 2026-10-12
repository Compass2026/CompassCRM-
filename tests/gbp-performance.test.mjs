import {test} from 'node:test';
import assert from 'node:assert/strict';
import {METRICS,completeMonths,normalizePerformance} from '../supabase/functions/gbp-performance/metrics.ts';
import {createGbpPerformance} from '../supabase/functions/gbp-performance/handler.ts';
const account='aaaaaaaaaaaaaaaaaaaaaaaa',client='00000000-0000-4000-8000-000000000001';
const fixture=()=>({success:true,accountId:account,platform:'googlebusiness',dateRange:{startDate:'2026-09-01',endDate:'2026-09-30'},metrics:Object.fromEntries(METRICS.map(m=>[m,{total:30,values:Array.from({length:30},(_,i)=>({date:`2026-09-${String(i+1).padStart(2,'0')}`,value:1}))}]))});
test('complete months respect Google delay and year boundary',()=>{
 assert.deepEqual(completeMonths(2,new Date('2026-10-12')), [{start:'2026-08-01',end:'2026-08-31'},{start:'2026-09-01',end:'2026-09-30'}]);
 assert.equal(completeMonths(1,new Date('2026-10-03'))[0].end,'2026-08-31');
 assert.equal(completeMonths(1,new Date('2027-01-10'))[0].start,'2026-12-01');
});
test('real zeros survive; missing, duplicate, wrong-account and inconsistent data are refused',()=>{
 const input=fixture();assert.deepEqual(normalizePerformance(input,account,'2026-09-01','2026-09-30').values,{gbp_views:120,gbp_clicks:30,gbp_call_clicks:30,gbp_directions:30});
 input.metrics.CALL_CLICKS={total:0,values:input.metrics.CALL_CLICKS.values.map(v=>({...v,value:0}))};assert.equal(normalizePerformance(input,account,'2026-09-01','2026-09-30').values.gbp_call_clicks,0);
 for(const change of [x=>x.accountId='other',x=>x.metrics.CALL_CLICKS.values.pop(),x=>x.metrics.CALL_CLICKS.values[1].date='2026-09-01',x=>x.metrics.CALL_CLICKS.total=99,x=>x.metrics.CALL_CLICKS.values[0].value=null,x=>delete x.metrics.WEBSITE_CLICKS]) {
  const bad=fixture();change(bad);assert.throws(()=>normalizePerformance(bad,account,'2026-09-01','2026-09-30'));
 }
});
function setup({role='admin',status=200,location='123',dbError=false}={}) {
 const calls=[],writes=[],logs=[];
 const binding={client_id:client,publish_account_id:account,publish_page_id:'locations/123',external_account_id:'locations/123'};
 const supabase={auth:{getUser:async()=>({data:{user:role?{id:'user'}:null}})},rpc:async(name,args)=>{
  if(name==='get_secret')return {data:args.secret_name==='SYNC_CRON_SECRET'?'cron':'secret'};
  writes.push(args);return dbError?{error:{message:'db failure'}}:{data:{status:'imported'}};
 },from(name){
  const q={select(){return q;},eq(){return q;},in(){return q;},maybeSingle:async()=>({data:{role}}),insert:async v=>{logs.push(v);return {};},update(v){logs.push(v);return {eq:async()=>({})};},then(resolve,reject){return Promise.resolve({data:[binding]}).then(resolve,reject);}};return q;
 }};
 const fetch=async(url,options)=>{calls.push({url:String(url),options});return String(url).includes('gmb-locations')?Response.json({selectedLocationId:location}):status===200?Response.json(fixture()):Response.json({error:'secret should never echo'},{status});};
 const handle=createGbpPerformance({supabase,fetch,now:()=>new Date('2026-10-12')});
 const run=()=>handle(new Request('https://example.test',{method:'POST',headers:{Authorization:'Bearer user'},body:JSON.stringify({client_id:client,months:1})}));
 return {run,calls,writes,logs};
}
test('import uses GET only, pins location, and writes exact client/month; provider errors never become zeros',async()=>{
 const ok=setup();assert.equal((await ok.run()).status,200);assert.equal(ok.writes.length,1);assert.equal(ok.writes[0].p_client_id,client);assert.equal(ok.writes[0].p_start,'2026-09-01');assert.ok(ok.calls.every(c=>c.options.method==='GET'&&c.options.redirect==='error'));assert.equal(ok.logs.at(-1).status,'completed');
 for(const options of [{status:402},{status:403},{location:'locations/999'}]) {const x=setup(options);const r=await(await x.run()).json();assert.equal(r.status,'partial');assert.equal(x.writes.length,0);assert.doesNotMatch(JSON.stringify(r),/secret should never echo/);}
 const db=setup({dbError:true});assert.equal((await(await db.run()).json()).results[0].code,'import_write_failed');
});
test('portal/member/anonymous cannot trigger imports',async()=>{
 for(const role of ['member',null]) {const x=setup({role});assert.equal((await x.run()).status,role?403:401);assert.equal(x.calls.length,0);assert.equal(x.writes.length,0);}
});
