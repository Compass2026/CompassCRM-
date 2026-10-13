import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFiveLayerOverview, checkScope, alertScope } from '../src/lib/operations-overview.ts';
const check=(key,state='recorded')=>({key,label:key,state,href:'/clients/a/keywords',detail:'Recorded source evidence'});
const client=(id,name,readiness)=>({id,name,readiness,recorded:0,unknown:0,freshness:{},multiBrand:true});
const alert=(clientId,key,severity='attention')=>({id:clientId+':'+key,clientId,clientName:clientId==='a'?'North':'South',title:key,detail:'Review current receipt',href:'/clients/'+clientId+'/social',severity});
const fixture=()=>({
 clients:[client('a','North',[check('brand'),check('services:safety'),check('services:forklift','waiting'),check('services:heavy','missing'),check('search','unknown'),check('analytics','blocked'),check('authority','blocked'),check('destination:safety'),check('destination:forklift','missing'),check('billing','missing'),check('portal','missing')]),
 client('b','South',[check('brand','missing'),check('search'),check('authority'),check('intake')])],
 alerts:[alert('a','review:article'),alert('a','ops:social-review:post'),alert('a','release:current','critical'),alert('b','integration:ga4'),alert('b','sms','setup')],
 sourceErrors:[],integrations:[],generatedAt:'2026-10-13T04:00:00Z',
});
test('keeps all five layers and supporting systems distinct',()=>{
 const x=buildFiveLayerOverview(fixture());
 assert.deepEqual(x.layers.map(l=>l.id),[1,2,3,4,5]);
 assert.equal(x.layers[3].alerts,2);
 assert.equal(x.layers[3].total,0);
 assert.equal(x.support.total,3);
 assert.equal(x.support.alerts,1);
 assert.equal(x.layers.reduce((n,l)=>n+l.alerts,0)+x.support.alerts,5);
});
test('counts independent brands without turning parent approval into brand readiness',()=>{
 const layer=buildFiveLayerOverview(fixture(),['a']).layers[0];
 assert.deepEqual(layer.checks,{recorded:2,waiting:1,missing:1,blocked:0,unknown:0});
 assert.equal(layer.total,4);
});
test('client selection isolates alerts, evidence, and next-action URLs',()=>{
 const x=buildFiveLayerOverview(fixture(),['b']);
 assert.equal(x.clients,1);
 assert.equal(x.layers[4].alerts,0);
 assert.equal(x.layers[0].checks.recorded,0);
 for(const l of [...x.layers,x.support]) if(l.next) assert.equal(l.next.clientId,'b');
 const empty=buildFiveLayerOverview(fixture(),[]);
 assert.equal(empty.clients,0);
 for(const l of [...empty.layers,empty.support]) {assert.equal(l.total,0);assert.equal(l.alerts,0);assert.equal(l.next,null);}
});
test('unknown and blocked evidence stay separate from missing and recorded',()=>{
 const data=fixture();data.sourceErrors=['Reporting source'];
 const x=buildFiveLayerOverview(data,['a']);
 assert.equal(x.partial,true);
 assert.equal(x.layers[1].checks.unknown,1);
 assert.equal(x.layers[1].checks.blocked,1);
 assert.equal(x.layers[1].checks.recorded,0);
 assert.equal(x.layers[1].next.title,'analytics');
});
test('critical current release precedes setup work and preserves exact workflow link',()=>{
 const data=fixture();data.alerts.push(alert('a','queued:old','setup'));
 const layer=buildFiveLayerOverview(data,['a']).layers[4];
 assert.equal(layer.critical,1);
 assert.equal(layer.next.title,'release:current');
 assert.equal(layer.next.href,'/clients/a/social');
});
test('no alerts does not imply completed readiness or healthy provider delivery',()=>{
 const data=fixture();data.alerts=[];
 const x=buildFiveLayerOverview(data,['a']);
 assert.equal(x.layers[2].next.title,'authority');
 assert.equal(x.layers[2].checks.blocked,1);
 assert.equal(x.layers[3].total,0);
 assert.equal(x.layers[3].next,null);
 assert.equal('healthy' in x.layers[3],false);
});
test('new unclassified evidence remains visible and unknown client alerts are excluded',()=>{
 const data=fixture();data.clients[0].readiness.push(check('future-key','unknown'));
 data.alerts.push(alert('a','future-system'),alert('outside','release:outside','critical'));
 const x=buildFiveLayerOverview(data);
 assert.equal(x.other.total,1);assert.equal(x.other.alerts,1);
 assert.equal(x.layers[4].critical,1);
});
test('classification uses stable keys even if client names and titles change',()=>{
 assert.equal(checkScope('claims:heavy'),1);
 assert.equal(checkScope('social-channel:heavy'),5);
 assert.equal(alertScope({...alert('a','review:blog'),title:'Publish tomorrow'}),4);
 assert.equal(alertScope(alert('a','ops:backlinks-research')),4);
 assert.equal(alertScope(alert('a','ops:backlinks-check')),5);
 assert.equal(alertScope(alert('a','ops:notifications')),'support');
});
test('overview does not mutate its source and is deterministic',()=>{
 const data=fixture(),before=JSON.stringify(data);
 assert.deepEqual(buildFiveLayerOverview(data),buildFiveLayerOverview(data));
 assert.equal(JSON.stringify(data),before);
});
