import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
// rank-sync imports pure helpers; load them into the same context first.
function loadRankSync(context,file='supabase/functions/rank-sync/index.ts'){
 const exportsObj={};context.exports=exportsObj;
 for (const helper of ['supabase/functions/_shared/rank-site.ts', 'supabase/functions/rank-sync/market.ts']) {
  vm.runInContext(ts.transpileModule(readFileSync(helper,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
 }
 Object.assign(context,exportsObj);
 const source=readFileSync(file,'utf8').replace(/^import .*?;\n/gm,'');
 vm.runInContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);
}
test('large rank queues use bounded lookups and surface database failures before consuming tasks',async()=>{
 for(const fail of [false,true]){
  const sizes=[],ready=Array.from({length:448},(_,i)=>({id:`task-${i}`,tag:`00000000-0000-4000-a000-${String(i).padStart(12,'0')}`}));
  let handler,gets=0;
  const supabase={rpc:async()=>({data:'credential'}),from(table){let ids=[];const q={select(){return q},in(key,value){ids=value;return q},eq(){return q},order(){return q},then(resolve){if(table==='keywords'){sizes.push(ids.length);resolve(fail?{error:{code:'DB_ERROR'}}:{data:ids.map(id=>({id,keyword:'fixture',city:null,client_id:'client',service_id:null}))});}else resolve({data:[]});}};return q;}};
  const context=vm.createContext({console:{log(){}},Response,Request,URL,Date,Map,Set,Promise,Error,btoa,createClient:()=>supabase,Deno:{env:{get:()=>''},serve:fn=>handler=fn},EdgeRuntime:{waitUntil(){throw Error('unexpected background')}},fetch:async url=>{if(String(url).endsWith('/tasks_ready'))return Response.json({tasks:[{result:ready}]});gets++;return Response.json({tasks:[{status_code:50000,status_message:'fixture unavailable'}]});}});
  loadRankSync(context);
  const r=await handler(new Request('https://test',{method:'POST',headers:{'x-cron-secret':'credential'},body:JSON.stringify({mode:'collect',wait:true})}));
  assert.equal(r.status,fail?503:200);assert.ok(sizes.every(n=>n<=80));assert.equal(gets,fail?0:448);
  if(!fail)assert.equal((await r.json()).matched,448);
 }
});
// FIXTURE SERPs: invented results for the matching rule only.
async function collectFixture(items,file='supabase/functions/rank-sync/index.ts',over={}){
 let handler,upserted=[];
 const tag='00000000-0000-4000-a000-000000000001';
 const tables={
  keywords:{data:[{id:tag,keyword:'fixture roofer',city:null,client_id:'client',service_id:null}]},
  clients:{data:[{id:'client',name:'Fixture Roofing',dba:null,city:'Town',state:'MO',website_url:'https://www.fixture-roofer.test',sites:[]}]},
  rank_runs:{data:[{id:'run',client_id:'client',started_at:'2026-10-19T06:00:00Z',checks_count:1}]},
  locations:{data:[{id:'home',city:'Town',lat:1,lng:2}]},
  ...over,
 };
 const supabase={rpc:async()=>({data:'credential'}),from(table){let op='select';const q={select(){return q},in(){return q},eq(){return q},lt(){return q},like(){return q},order(){return q},
  upsert(rows){op='upsert';upserted=rows;return q},update(){op='update';return q},insert(){op='insert';return q},
  then(resolve){resolve(op==='upsert'?{data:upserted.map((_,i)=>({id:i}))}:table==='rank_snapshots'?{count:1}:tables[table]??{data:[]});}};return q;}};
 const context=vm.createContext({console:{log(){}},Response,Request,URL,Date,Map,Set,Promise,Error,btoa,createClient:()=>supabase,Deno:{env:{get:()=>''},serve:fn=>handler=fn},EdgeRuntime:{waitUntil(){throw Error('unexpected background')}},fetch:async url=>{if(String(url).endsWith('/tasks_ready'))return Response.json({tasks:[{result:[{id:'task-1',tag}]}]});return Response.json({tasks:[{status_code:20000,cost:0.0006,data:{location_coordinate:'1,2'},result:[{items}]}]});}});
 loadRankSync(context,file);
 const r=await handler(new Request('https://test',{method:'POST',headers:{'x-cron-secret':'credential'},body:JSON.stringify({mode:'collect',wait:true})}));
 assert.equal(r.status,200);
 return {organic:upserted.find(x=>x.result_type==='organic'),pack:upserted.find(x=>x.result_type==='map_pack'),rows:upserted,body:await r.json()};
}
const thirdParty=[
 {type:'local_pack',title:'Other Roofing Co',domain:'other.test'},
 {type:'local_pack',title:'Fixture Roofing',domain:null},
 {type:'organic',rank_group:1,title:'Fixture Roofing | Facebook',domain:'www.facebook.com',url:'https://www.facebook.com/FixtureRoofing/'},
 {type:'organic',rank_group:2,title:'Fixture Roofing LLC reviews',domain:'www.angi.com',url:'https://www.angi.com/fixture'},
];
test('organic rank is the website host only; the business name still counts in the map pack',async()=>{
 const {organic,pack}=await collectFixture([...thirdParty,{type:'organic',rank_group:3,title:'Roofer in Town',domain:'fixture-roofer.test',url:'https://fixture-roofer.test/services/roofing'}]);
 assert.equal(organic.position,3);assert.equal(organic.url_ranked,'https://fixture-roofer.test/services/roofing');
 assert.equal(pack.position,2);assert.equal(organic.location_id,'home');
});
test('organic is not found when only third-party pages carry the business name',async()=>{
 const {organic,pack}=await collectFixture(thirdParty);
 assert.equal(organic.position,null);assert.equal(organic.url_ranked,null);assert.equal(pack.position,2);
});

// FIXTURE: a multi-brand client whose three sites come back in arbitrary order.
const tag1='00000000-0000-4000-a000-000000000001';
const brands=order=>({
 keywords:{data:[{id:tag1,keyword:'fixture forklift class',city:null,client_id:'client',service_id:'svc-lift'}]},
 clients:{data:[{id:'client',name:'Fixture Group LLC',dba:null,city:'Town',state:'MO',website_url:'https://safety.fixture.test/',
  sites:order([{id:'s1',url:'https://safety.fixture.test/'},{id:'s2',url:'https://www.lift.fixture.test/'},{id:'s3',url:'https://heavy.fixture.test/'}]),
  client_brand_workspaces:order([
   {id:'w1',name:'Fixture Safety',website_url:'https://safety.fixture.test/',blog_site_id:'s1',service_ids:['svc-osha']},
   {id:'w2',name:'Fixture Lift',website_url:'https://www.lift.fixture.test/',blog_site_id:'s2',service_ids:['svc-lift']},
   {id:'w3',name:'Fixture Heavy',website_url:'https://heavy.fixture.test/',blog_site_id:'s3',service_ids:['svc-dig']}])}]},
});
const sister=[{type:'organic',rank_group:1,title:'Forklift certification',domain:'safety.fixture.test',url:'https://safety.fixture.test/services/forklift'}];
test('multi-brand: the keyword is judged against its own brand site in any order, and the host is stored',async()=>{
 for(const order of [x=>x,x=>[...x].reverse(),x=>[x[1],x[2],x[0]]]){
  const {organic}=await collectFixture([...sister,{type:'organic',rank_group:4,title:'Classes',domain:'www.lift.fixture.test',url:'https://www.lift.fixture.test/classes'}],undefined,brands(order));
  assert.equal(organic.position,4);assert.equal(organic.url_ranked,'https://www.lift.fixture.test/classes');assert.equal(organic.site_host,'lift.fixture.test');
 }
});
test('multi-brand: a sister brand\'s page is never the keyword\'s rank',async()=>{
 const {organic}=await collectFixture(sister,undefined,brands(x=>x));
 assert.equal(organic.position,null);assert.equal(organic.url_ranked,null);assert.equal(organic.site_host,'lift.fixture.test');
});
test('multi-brand: a keyword no brand site owns is not recorded, and the run says why',async()=>{
 const t=brands(x=>x);t.keywords={data:[{id:tag1,keyword:'fixture unowned',city:null,client_id:'client',service_id:null}]};
 const {rows,body}=await collectFixture(sister,undefined,t);
 assert.equal(rows.length,0);assert.ok(body.errors.some(e=>/fixture unowned: not recorded, it has no service/.test(e)));
});
test('single-site: the stored host is the client\'s one website',async()=>{
 const {organic}=await collectFixture([{type:'organic',rank_group:2,title:'Roofer',domain:'fixture-roofer.test',url:'https://fixture-roofer.test/'}]);
 assert.equal(organic.position,2);assert.equal(organic.site_host,'fixture-roofer.test');
});

test('online stores do not collect local ranks or silently use their mailing city',async()=>{
 const {rows,body}=await collectFixture(thirdParty,undefined,{
  clients:{data:[{id:'client',name:'Online Store',business_type:'ecommerce',city:'Mailing City',state:'CO',website_url:'https://fixture-roofer.test',sites:[]}]},
 });
 assert.equal(rows.length,0);
 assert.ok(body.errors.some(e=>e.includes('no city fallback used')));
});
