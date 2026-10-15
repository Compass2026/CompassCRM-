import {test} from 'node:test';
import assert from 'node:assert/strict';
import {blankRequirements,reviewHealth,buildRolloutScorecard,validateRolloutWrite} from '../src/lib/agency-rollout.ts';
const now='2026-10-15T01:00:00Z';
const requirements=()=>blankRequirements().map(r=>({...r,applicability:r.key==='intelligence'?'required':'excluded',state:'current',evidence_ref:'receipt',checked_at:'2026-10-14T00:00:00Z',valid_until:'2026-10-17T00:00:00Z',reason:'Agreed scope',review_trigger:'Scope renewal',owner:'Operator',next_action:'Review next cycle'}));
const review=(patch={})=>({id:'review1',client_id:'a',brand_workspace_id:null,version:1,standard_version:'1.0',stage:'unassessed',requirements:requirements(),scope_ref:'Agreement',configuration_ref:'Configuration',pilot_ref:'Cycle and measurement',cycle_one_start:'2026-09-28',cycle_two_start:'2026-10-05',cycle_one_ref:'Cycle1',cycle_two_ref:'Cycle2',owner:'Operator',next_action:'Review pilot',reason:'Evidence reviewed',critical_clear:true,accepted:true,reviewed_by:'human',reviewed_at:now,...patch});
const data=(patch={})=>({clients:[{id:'a',name:'A'},{id:'b',name:'B'}],integrations:[],sourceErrors:[],alerts:[],generatedAt:now,...patch});
test('no review or missing/partial source read never certifies operation',()=>{
 assert.equal(buildRolloutScorecard(data(),[],[])[0].stage,'unassessed');
 assert.equal(buildRolloutScorecard(data(),null,[])[0].health,'unknown');
 assert.equal(buildRolloutScorecard(data({sourceErrors:['truncated']}),[review()],[])[0].health,'unknown');
});
test('expired evidence degrades health without erasing historical pilot',()=>{
 const r=review({stage:'pilot'});r.requirements[0].valid_until='2026-10-14T20:00:00Z';
 const row=buildRolloutScorecard(data(),[r],[])[0];assert.equal(row.stage,'pilot');assert.equal(row.health,'attention');
});
test('current source failure defeats manual green; optional sources do not enter denominator',()=>{
 const r=review();r.requirements.find(r=>r.key==='ga4').applicability='required';
 const row=buildRolloutScorecard(data({integrations:[{clientId:'a',source:'ga4',state:'failed',scopes:[]}]}),[r],[])[0];
 assert.equal(row.health,'blocked');assert.equal(row.scopes[0].required,2);
 assert.equal(buildRolloutScorecard(data(),[review()],[])[0].health,'current');
});
test('BHG-style brand stages roll up to the least proven scope, shared GBP never copied',()=>{
 const brands=[{id:'safety',client_id:'a',name:'Safety',ga4_property:'properties/1',gsc_property:null},{id:'forklift',client_id:'a',name:'Forklift',ga4_property:'properties/2',gsc_property:null}];
 const parent=review({stage:'operating'}),child=review({id:'child',brand_workspace_id:'safety',stage:'pilot'});
 assert.equal(buildRolloutScorecard(data(),[parent,child],brands)[0].stage,'unassessed');
 child.requirements.find(r=>r.key==='gbp').applicability='required';
 const row=buildRolloutScorecard(data({integrations:[{clientId:'a',source:'gbp',state:'verified',scopes:[]}]}),[parent,child],brands)[0];
 assert.equal(row.scopes[1].health,'unknown');assert.equal(row.scopes[2].review,null);
});
test('different client reviews and brand evidence remain isolated',()=>{
 const r=review({client_id:'b',stage:'operating'});
 const rows=buildRolloutScorecard(data(),[r],[]);assert.equal(rows[0].stage,'unassessed');assert.equal(rows[1].stage,'operating');
});
test('supporting SMS incidents do not degrade marketing; unresolved release does, recovery clears it',()=>{
 const alert={id:'a:ops:notifications',clientId:'a',severity:'critical'};
 assert.equal(buildRolloutScorecard(data({alerts:[alert]}),[review()],[])[0].health,'current');
 assert.equal(buildRolloutScorecard(data({alerts:[{...alert,id:'a:release:uncertain'}]}),[review()],[])[0].health,'blocked');
});
test('scope decisions must be explicit with reason, reference and review trigger',()=>{
 const r=review({stage:'scoped'});assert.equal(validateRolloutWrite(r,null,now),null);
 r.requirements[1].review_trigger='';assert.match(validateRolloutWrite(r,null,now),/review trigger/);
 r.requirements=blankRequirements();assert.match(validateRolloutWrite(r,null,now),/Scoped requires/);
});
test('concurrent review, duplicate requirement and skipped stage refused',()=>{
 assert.match(validateRolloutWrite(review({version:2}),null,now),/changed/);
 assert.match(validateRolloutWrite(review({stage:'pilot'}),null,now),/one stage/);
 const r=review();r.requirements[1]=r.requirements[0];assert.match(validateRolloutWrite(r,null,now),/exactly once/);
});
test('ready needs fresh evidence and critical incident attestation',()=>{
 const old=review({stage:'configured'}),next=review({stage:'ready',version:2,critical_clear:false});
 assert.match(validateRolloutWrite(next,old,now),/critical/);next.critical_clear=true;
 assert.equal(validateRolloutWrite(next,old,now),null);next.requirements[0].valid_until='2026-10-14T00:00:00Z';
 assert.match(validateRolloutWrite(next,old,now),/verify/);
});
test('scope change cannot inherit a historical pilot or operating acceptance',()=>{
 const old=review({stage:'pilot'}),next=review({version:2,stage:'pilot',scope_ref:'New agreement'});
 assert.match(validateRolloutWrite(next,old,now),/Scope changed/);
 next.stage='configured';assert.equal(validateRolloutWrite(next,old,now),null);
});
test('operating requires adjacent completed delivery cycles and explicit acceptance',()=>{
 const old=review({stage:'pilot'}),next=review({version:2,stage:'operating'});
 assert.equal(validateRolloutWrite(next,old,now),null);next.cycle_two_start='2026-10-06';
 assert.match(validateRolloutWrite(next,old,now),/consecutive/);next.cycle_two_start='2026-10-05';next.accepted=false;
 assert.match(validateRolloutWrite(next,old,now),/acceptance/);
});
test('future checks and absent references never establish current health',()=>{
 const r=review();r.requirements[0].checked_at='2099-01-01';assert.equal(reviewHealth(r,now),'unknown');
 assert.match(validateRolloutWrite(r,null,now),/past check/);
});
