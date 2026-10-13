import {test} from 'node:test';
import assert from 'node:assert/strict';
import {integrationEvidence,completeRead} from '../src/lib/integration-health.ts';
const now='2026-10-13T03:00:00Z';
const receipt={id:'receipt',client_id:'a',property:'properties/123',period:'2026-10-01',period_end:'2026-10-08',created_at:'2026-10-12T10:00:00Z'};
const run={id:'run',client_id:'a',created_at:'2026-10-12T10:00:00Z',finished_at:'2026-10-12T10:01:00Z',status:'completed',results:[{month:'2026-10-01',status:'imported',receipt_id:'receipt'}]};
function fixture(){return {bindings:{ga4:[{clientId:'a',label:'A',property:'properties/123'}],gsc:[],gbp:[]},imports:{ga4:[receipt],gsc:[],gbp:[]},runs:{ga4:[run],gsc:[],gbp:[]}};}
const evaluate=input=>integrationEvidence(input,'a','ga4',now);
test('verified requires matching provider outcome, receipt, current window and recent retrieval',()=>{
 const f=fixture();assert.equal(evaluate(f).state,'verified');
 f.runs.ga4[0]={...run,results:[]};assert.equal(evaluate(f).state,'missing');
 f.runs.ga4[0]={...run,results:[{status:'no_data',code:'no_reported_data'}]};assert.equal(evaluate(f).state,'failed');
 f.runs.ga4[0]={...run,results:[{status:'imported',receipt_id:'nonexistent'}]};assert.equal(evaluate(f).state,'unknown');
 f.runs.ga4=[];assert.equal(evaluate(f).state,'unknown');
 f.imports.ga4=[];assert.equal(evaluate(f).state,'missing');
});
test('unchanged outcome confirms retrieval without moving immutable receipt timestamp',()=>{
 const f=fixture();f.imports.ga4=[{...receipt,created_at:'2026-10-09T10:00:00Z'}];f.runs.ga4=[{...run,results:[{status:'unchanged',month:receipt.period}]}];
 assert.equal(evaluate(f).state,'verified');assert.equal(evaluate(f).lastSuccess,run.finished_at);assert.equal(evaluate(f).lastImported,'2026-10-09T10:00:00Z');
});
test('historical failed runs do not override recovery, latest partial preserves success and failure',()=>{
 const f=fixture();f.runs.ga4.push({...run,id:'old',created_at:'2026-10-10T10:00:00Z',status:'partial',results:[{status:'failed',code:'google_token_failed'}]});
 assert.equal(evaluate(f).state,'verified');
 f.runs.ga4.unshift({...run,id:'latest',created_at:'2026-10-13T02:00:00Z',finished_at:'2026-10-13T02:01:00Z',status:'partial',results:[...run.results,{status:'failed',code:'no_reported_data'}]});
 assert.equal(evaluate(f).state,'partial');assert.match(evaluate(f).evidence,/no_reported_data/);
});
test('GA4 has a seven-day data threshold, complete-month GSC and GBP use 45 days',()=>{
 const f=fixture();f.imports.ga4=[{...receipt,period_end:'2026-09-30'}];assert.equal(evaluate(f).state,'stale');
 f.bindings.gsc=f.bindings.ga4;f.imports.gsc=f.imports.ga4;f.runs.gsc=f.runs.ga4;
 assert.equal(integrationEvidence(f,'a','gsc',now).state,'verified');
 f.imports.gsc=[{...f.imports.gsc[0],created_at:'2026-10-09T10:00:00Z'}];f.runs.gsc=[{...run,created_at:'2026-10-09T10:00:00Z',finished_at:'2026-10-10T10:00:00Z'}];assert.equal(integrationEvidence(f,'a','gsc',now).state,'stale');
});
test('failed or truncated reads, malformed results and future timestamps never verify',()=>{
 assert.equal(completeRead({data:[],count:0,error:null})?.length,0);
 assert.equal(completeRead({data:[1],count:3001,error:null}),null);
 assert.equal(completeRead({data:[1],count:null,error:null}),null);
 for(const kind of ['bindings','imports','runs']){const f=fixture();f[kind].ga4=null;assert.equal(evaluate(f).state,'unknown');}
 const f=fixture();f.runs.ga4=[{...run,created_at:'2027-01-01'}];assert.equal(evaluate(f).state,'unknown');
 f.runs.ga4=[{...run,results:{status:'completed'}}];assert.equal(evaluate(f).state,'missing');
 f.runs.ga4=[{...run,finished_at:null}];assert.equal(evaluate(f).state,'unknown');
});
test('client and property identity are exact; shared GBP outcomes never leak to other clients',()=>{
 const f=fixture();f.imports.ga4=[{...receipt,client_id:'b'}];assert.equal(evaluate(f).state,'missing');
 f.imports.ga4=[{...receipt,property:'properties/456'}];assert.equal(evaluate(f).state,'missing');
 f.bindings.gbp=[{clientId:'a',label:'Shared GBP',property:'locations/123',accountId:'account'}];
 f.imports.gbp=[{...receipt,account_id:'account',location_id:'locations/123'}];
 f.runs.gbp=[{...run,client_id:undefined,results:[{status:'failed',client_id:'b',code:'provider_http_403'},{...run.results[0],client_id:'a'}]}];
 assert.equal(integrationEvidence(f,'a','gbp',now).state,'verified');
 assert.equal(integrationEvidence(f,'b','gbp',now).state,'unconfigured');
 f.runs.gbp=[{...run,client_id:undefined,results:[]}];assert.equal(integrationEvidence(f,'a','gbp',now).lastAttempt,null);
});
test('three brands remain separate; one successful property cannot verify all brands',()=>{
 const f=fixture();f.bindings.ga4.push({clientId:'a',label:'Forklift',property:'properties/456'},{clientId:'a',label:'Heavy equipment',property:''});
 const e=evaluate(f);assert.equal(e.scopes.length,3);assert.equal(e.scopes[0].state,'current');assert.equal(e.scopes[1].state,'missing');assert.equal(e.scopes[2].state,'missing');assert.equal(e.state,'missing');assert.equal(e.lastSuccess,null);
 f.bindings.ga4.pop();f.imports.ga4.push({...receipt,id:'r2',property:'properties/456'});assert.equal(evaluate(f).state,'unknown');assert.match(evaluate(f).evidence,/do not identify the brand/);
});
test('interrupted runs and safe error codes have actionable states without arbitrary error payloads',()=>{
 const f=fixture();f.runs.ga4=[{...run,status:'running',finished_at:null,results:[]}];assert.equal(evaluate(f).state,'failed');
 f.runs.ga4=[{...run,status:'partial',results:[{status:'failed',code:'secret raw provider response'}]}];
 assert.doesNotMatch(JSON.stringify(evaluate(f)),/secret raw/);assert.match(evaluate(f).evidence,/provider_result_unverified/);
});
function scopedFixture(){
 const f=fixture();f.bindings.ga4=[{clientId:'a',label:'Safety',property:'properties/123',brandId:'safety',host:'safety.test'},{clientId:'a',label:'Forklift',property:'properties/456',brandId:'forklift',host:'forklift.test'}];
 f.imports.ga4=[{...receipt,host:'safety.test'},{...receipt,id:'r2',property:'properties/456',host:'forklift.test'}];
 f.runs.ga4=f.bindings.ga4.map((b,i)=>({...run,id:'run'+i,results:[{scope_version:1,property:b.property,brand_workspace_id:b.brandId,website_host:b.host,status:'imported',receipt_id:i?'r2':'receipt'}]}));return f;
}
test('each brand requires an independent scoped outcome, exact host and matching receipt',()=>{
 const f=scopedFixture();assert.equal(evaluate(f).state,'verified');assert.equal(evaluate(f).scopes.length,2);
 f.runs.ga4.pop();assert.equal(evaluate(f).state,'unknown');assert.equal(evaluate(f).lastSuccess,null);
 f.runs.ga4[0].results[0].property='properties/456';assert.notEqual(evaluate(f).state,'verified');
 const cross=scopedFixture();cross.runs.ga4[1].results[0].brand_workspace_id='other';assert.notEqual(evaluate(cross).state,'verified');
 const host=scopedFixture();host.runs.ga4[1].results[0].website_host='other.test';assert.notEqual(evaluate(host).state,'verified');
 const receiptHost=scopedFixture();receiptHost.imports.ga4[1].host='other.test';assert.equal(evaluate(receiptHost).state,'missing');
});
test('recovery is property-specific and unrelated later runs cannot hide failures',()=>{
 const f=scopedFixture();f.runs.ga4[0].results[0]={...f.runs.ga4[0].results[0],status:'failed',code:'google_connection_missing'};
 assert.equal(evaluate(f).state,'failed');assert.match(evaluate(f).scopes[0].evidence,/google_connection_missing/);assert.equal(evaluate(f).scopes[1].health,'verified');
 f.runs.ga4.push({...run,id:'recovery',created_at:'2026-10-13T02:00Z',finished_at:'2026-10-13T02:01Z',results:[{...f.runs.ga4[0].results[0],status:'unchanged',month:receipt.period,period_end:receipt.period_end}]});
 assert.equal(evaluate(f).state,'verified');
 f.runs.ga4.at(-1).results[0].period_end='2026-10-09';assert.equal(evaluate(f).state,'unknown');
});
test('processing waits are explicit, never healthy, and expire without a new check',()=>{
 const f=scopedFixture();f.runs.ga4[1].results=[{...f.runs.ga4[1].results[0],status:'waiting',code:'property_processing_delay'}];
 assert.equal(evaluate(f).state,'waiting');assert.equal(evaluate(f).lastSuccess,null);
 f.runs.ga4[1].created_at='2026-10-09T10:00Z';f.runs.ga4[1].finished_at='2026-10-09T10:01Z';assert.equal(evaluate(f).state,'stale');
});
test('parent schedule can verify matching brand property and host, never another brand',()=>{
 const f=scopedFixture();f.runs.ga4[0].results[0].brand_workspace_id=null;assert.equal(evaluate(f).state,'verified');
 f.runs.ga4[0].results[0].receipt_id='r2';assert.equal(evaluate(f).state,'unknown');
});
