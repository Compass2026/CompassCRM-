import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeGa4,reportingPeriods,websiteHost} from '../supabase/functions/ga4-performance/metrics.ts';
import {createGa4Performance} from '../supabase/functions/ga4-performance/handler.ts';
const id='00000000-0000-4000-8000-000000000001',property='properties/123';
const fixture=()=>({metricHeaders:['sessions','totalUsers','screenPageViews'].map(name=>({name,type:'TYPE_INTEGER'})),rows:[{metricValues:[{value:'12'},{value:'10'},{value:'20'}]}],rowCount:1,metadata:{timeZone:'America/Chicago'}});
test('GA4 totals reject malformed, sampled, thresholded and missing data',()=>{
 assert.equal(normalizeGa4(fixture(),'America/Chicago','example.test','complete_month').values.website_sessions,12);
 for(const mutate of [x=>x.rows=[],x=>x.metricHeaders[0].name='totalUsers',x=>x.rows[0].metricValues[0].value='-1',x=>x.metadata.timeZone='UTC',x=>x.metadata.subjectToThresholding=true,x=>x.metadata.samplingMetadatas=[{}],x=>x.metadata.dataLossFromOtherRow=true,x=>x.dimensionHeaders=[{}]]){const x=fixture();mutate(x);assert.throws(()=>normalizeGa4(x,'America/Chicago','example.test','complete_month'));}
});
test('launch months and settled month-to-date are separated and never predate property creation',()=>{
 assert.deepEqual(reportingPeriods(2,new Date('2026-10-12T20:00Z'),'America/Chicago','2026-09-21T10:00Z'),[{start:'2026-09-21',end:'2026-09-30',coverage:'partial_launch_month'},{start:'2026-10-01',end:'2026-10-08',coverage:'month_to_date'}]);
 assert.deepEqual(reportingPeriods(6,new Date('2026-10-12T20:00Z'),'America/Chicago','2026-10-11T10:00Z'),[]);
 assert.equal(reportingPeriods(1,new Date('2026-10-03T00:00Z'),'America/Chicago','2025-01-01')[0].end,'2026-08-31');
 assert.equal(websiteHost('https://www.example.test'),'example.test');assert.throws(()=>websiteHost('https://user:pass@example.test'));
});
function setup({role='admin',website='https://example.test',status=200,empty=false,dbError=false}={}) {
 const calls=[],writes=[],logs=[];
 const supabase={auth:{getUser:async()=>({data:{user:role?{id:'user'}:null}})},rpc:async(name,args)=>{if(name==='get_secret')return {data:args.secret_name==='SYNC_CRON_SECRET'?'cron':'secret'};writes.push(args);return dbError?{error:{}}:{data:{status:'imported'}};},from(name){const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:name==='clients'?{id,status:'active',ga4_property:property,website_url:'https://example.test'}:{role}}),insert:async v=>{logs.push(v);return {};},update(v){logs.push(v);return {eq:async()=>({})};}};return q;}};
 const request=async(url,options)=>{calls.push({url:String(url),options});if(String(url).endsWith('/token'))return Response.json({access_token:'secret token'});if(String(url).includes('/dataStreams'))return Response.json({dataStreams:[{webStreamData:{defaultUri:website}}]});if(!String(url).endsWith(':runReport'))return Response.json({name:property,timeZone:'America/Chicago',createTime:'2025-01-01T10:00Z'});return status===200?Response.json(empty?{rows:[]}:fixture()):Response.json({error:'private payload'},{status});};
 return {calls,writes,logs,run:(body={client_id:id,months:2},headers={Authorization:'Bearer user'})=>createGa4Performance({supabase,fetch:request,now:()=>new Date('2026-10-12T20:00Z')})(new Request('https://test',{method:'POST',headers,body:JSON.stringify(body)}))};
}
test('GA4 importer verifies stream, uses exact hostname filters and oldest-first idempotent boundary',async()=>{
 const x=setup();assert.equal((await x.run()).status,200);assert.deepEqual(x.writes.map(w=>w.p_start),['2026-08-01','2026-09-01','2026-10-01']);assert.ok(x.writes.every(w=>w.p_client_id===id&&w.p_property===property));
 for(const q of x.calls.filter(c=>c.url.endsWith(':runReport')))assert.deepEqual(JSON.parse(q.options.body).dimensionFilter.filter.inListFilter.values,['example.test','www.example.test']);
 assert.equal(x.logs.at(-1).status,'completed');
});
test('auth, wrong stream, empty responses and provider failures never write synthetic data',async()=>{
 for(const role of ['member',null]){const x=setup({role});assert.equal((await x.run()).status,role?403:401);assert.equal(x.calls.length,0);}
 for(const options of [{website:'https://example.test.evil.test'},{status:403},{status:429},{empty:true}]){const x=setup(options);const r=await(await x.run()).json();assert.equal(x.writes.length,0);assert.doesNotMatch(JSON.stringify(r),/private payload|secret token/);}
 const x=setup({dbError:true});assert.equal((await(await x.run()).json()).results[0].code,'import_write_failed');assert.equal(x.writes.length,1);
 const cron=setup({role:null});assert.equal((await cron.run(undefined,{'x-cron-secret':'cron'})).status,200);
});
