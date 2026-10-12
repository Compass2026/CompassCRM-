import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeGsc,propertyMatchesWebsite} from '../supabase/functions/gsc-performance/metrics.ts';
import {createGscPerformance} from '../supabase/functions/gsc-performance/handler.ts';
const id='00000000-0000-4000-8000-000000000001',property='sc-domain:example.test';
const fixture=()=>({responseAggregationType:'byProperty',rows:[{clicks:12,impressions:123}]});
test('property totals refuse query/page data, missing observations and malformed metrics',()=>{
 assert.equal(normalizeGsc(fixture()).values.search_clicks,12);
 assert.equal(normalizeGsc({responseAggregationType:'byProperty',rows:[{clicks:0,impressions:0}]}).values.search_clicks,0);
 for(const mutate of [x=>x.rows=[],x=>x.rows[0].keys=['page'],x=>x.rows.push(x.rows[0]),x=>x.responseAggregationType='byPage',x=>x.rows[0].clicks=124,x=>x.rows[0].impressions=-1,x=>x.rows[0].clicks=null,x=>x.rows[0].clicks=.5]){const x=fixture();mutate(x);assert.throws(()=>normalizeGsc(x));}
});
test('exact domain binding prevents substring and foreign path matches',()=>{
 for(const p of [property,'https://www.example.test/'])assert.equal(propertyMatchesWebsite(p,'https://example.test'),true);
 for(const p of ['sc-domain:other.test','sc-domain:example.test.evil.test','https://example.test/sub/','https://example.test/?q=x','https://user:pass@example.test/','javascript:example.test'])assert.equal(propertyMatchesWebsite(p,'https://example.test'),false);
});
function setup({role='admin',inventory=property,status=200,dbError=false}={}) {
 const calls=[],writes=[],logs=[];
 const supabase={auth:{getUser:async()=>({data:{user:role?{id:'user'}:null}})},rpc:async(name,args)=>{if(name==='get_secret')return {data:args.secret_name==='SYNC_CRON_SECRET'?'cron':'secret'};writes.push(args);return dbError?{error:{}}:{data:{status:'imported'}};},from(name){const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:name==='clients'?{id,status:'active',gsc_property:property,website_url:'https://example.test'}:{role}}),insert:async v=>{logs.push(v);return {};},update(v){logs.push(v);return {eq:async()=>({})};}};return q;}};
 const request=async(url,options)=>{calls.push({url:String(url),options});if(String(url).endsWith('/token'))return Response.json({access_token:'secret token'});if(String(url).endsWith('/sites'))return Response.json({siteEntry:[{siteUrl:inventory,permissionLevel:'siteOwner'}]});return status===200?Response.json(fixture()):Response.json({error:'private provider payload'},{status});};
 const handle=createGscPerformance({supabase,fetch:request,now:()=>new Date('2026-10-12')});
 return {calls,writes,logs,run:(body={client_id:id,months:2},headers={Authorization:'Bearer user'})=>handle(new Request('https://test',{method:'POST',headers,body:JSON.stringify(body)}))};
}
test('reads finalized unfiltered months oldest first and never writes to Google',async()=>{
 const x=setup();assert.equal((await x.run()).status,200);assert.deepEqual(x.writes.map(w=>w.p_start),['2026-08-01','2026-09-01']);assert.ok(x.writes.every(w=>w.p_client_id===id&&w.p_property===property));
 const queries=x.calls.filter(c=>c.url.endsWith('/query'));assert.equal(queries.length,2);for(const q of queries){assert.deepEqual(JSON.parse(q.options.body).dimensions,[]);assert.equal(JSON.parse(q.options.body).dataState,'final');assert.equal(JSON.parse(q.options.body).aggregationType,'byProperty');}
 assert.ok(x.calls.every(c=>c.options.redirect==='error'&&(c.options.method==='GET'||/\/token$|\/searchAnalytics\/query$/.test(c.url))));assert.equal(x.logs.at(-1).status,'completed');
});
test('auth, inventory, provider and write failures cannot produce success or fabricated zero',async()=>{
 for(const role of ['member',null]){const x=setup({role});assert.equal((await x.run()).status,role?403:401);assert.equal(x.calls.length,0);}
 for(const options of [{inventory:'sc-domain:other.test'},{status:403},{status:429}]){const x=setup(options);const result=await(await x.run()).json();assert.equal(x.writes.length,0);assert.equal(x.logs.at(-1).status,'partial');assert.doesNotMatch(JSON.stringify(result),/private provider payload|secret token/);}
 const db=setup({dbError:true});assert.equal((await(await db.run()).json()).results[0].code,'import_write_failed');assert.equal(db.writes.length,1);
 const bad=setup();assert.equal((await bad.run({client_id:id,months:7})).status,400);assert.equal(bad.calls.length,0);
 const cron=setup({role:null});assert.equal((await cron.run(undefined,{'x-cron-secret':'cron'})).status,200);
});
