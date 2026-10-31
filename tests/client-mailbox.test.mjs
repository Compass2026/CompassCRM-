import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {SCOPES,missingScopes,mime,decode,plainText,returnUrl,b64} from '../supabase/functions/client-mailbox/mail.ts';
import {createMailbox} from '../supabase/functions/client-mailbox/handler.ts';
const client='11111111-1111-4111-8111-111111111111', actor='22222222-2222-4222-8222-222222222222', other='33333333-3333-4333-8333-333333333333', inquiry='44444444-4444-4444-8444-444444444444',revision='55555555-5555-4555-8555-555555555555';
test('mail headers cannot inject recipients; Unicode text round trips',()=>{
 const msg={sender:'owner@example.test',recipient:'lead@example.test',subject:'Training résumé',body:'Hello ✓',rfc_message_id:'<one@example.test>'};
 const raw=decode(mime(msg,'<prior@example.test>'));assert.match(raw,/In-Reply-To: <prior@example.test>/);assert.match(raw,/Content-Type: text\/plain/);
 assert.throws(()=>mime({...msg,recipient:'x@example.test\r\nBcc: victim@example.test'}));
 assert.throws(()=>mime({...msg,subject:'Hello\nBcc: victim@example.test'}));
 assert.equal(plainText({mimeType:'multipart/alternative',parts:[{mimeType:'text/html',body:{data:b64('<script>bad()</script>')}},{mimeType:'text/plain',body:{data:b64('Hello ✓')}}]}),'Hello ✓');
});
test('mailbox scopes exclude agency operations and callbacks are exact allowlisted origins',()=>{
 assert.equal(missingScopes(SCOPES.join(' ')).length,0);assert.equal(missingScopes('openid email').length,2);
 assert.ok(!SCOPES.some(s=>/compose|modify|business|analytics|drive/.test(s)));
 assert.equal(returnUrl('https://crm.example.test',['https://crm.example.test'],client,true),'https://crm.example.test/portal/inquiries');
 for(const origin of ['https://crm.example.test.evil.test','http://crm.example.test','https://crm.example.test/path','https://user@crm.example.test'])assert.throws(()=>returnUrl(origin,['https://crm.example.test'],client,false));
});
function fakeDB({portalClient=client,active=true,member=false}={}){
 const tables={clients:[{id:client,status:'active'},{id:other,status:'active'}],crm_lite_settings:[{client_id:client,enabled:true,portal_enabled:true},{client_id:other,enabled:true,portal_enabled:true}],team_members:member?[{auth_user_id:actor,role:'admin',email:'admin@example.test'}]:[],portal_users:[{id:actor,auth_user_id:actor,client_id:portalClient,is_active:active,email:'owner@example.test'}],client_mailboxes:[{client_id:client,expected_email:'owner@example.test',enabled:true,connected_email:'owner@example.test',token_secret:'PRIVATE_TOKEN',generation:revision}],inquiries:[{id:inquiry,client_id:client,email:'lead@example.test'}],client_email_threads:[],client_email_drafts:[],client_email_messages:[]};
 const writes=[];return {tables,writes,auth:{getUser:async jwt=>jwt==='valid'?{data:{user:{id:actor}}}:{data:null,error:'bad'}},rpc:async()=>({data:null,error:null}),from(table){let filters=[],action=null,payload;const q={select(){return q},eq(k,v){filters.push([k,v]);return q},in(k,v){filters.push([k,v]);return q},order(){return q},limit(){return q},update(v){action='update';payload=v;return q},insert(v){action='insert';payload=v;return q},upsert(v){action='upsert';payload=v;return q},delete(){action='delete';return q},maybeSingle:async()=>{const rows=(tables[table]||[]).filter(r=>filters.every(([k,v])=>Array.isArray(v)?v.includes(r[k]):r[k]===v));return {data:rows[0]||null,error:null}},then(resolve){if(action)writes.push({table,action,payload});return Promise.resolve({data:(tables[table]||[]).filter(r=>filters.every(([k,v])=>r[k]===v)),error:null}).then(resolve)}};return q;}};
}
const req=(body,jwt='valid')=>new Request('https://project.example.test/functions/v1/client-mailbox',{method:'POST',headers:{Authorization:'Bearer '+jwt},body:JSON.stringify(body)});
test('unauthenticated, inactive and cross-client callers cannot read or write mailbox data',async()=>{
 let calls=0;const fetcher=async()=>{calls++;throw Error('unexpected network')};
 for(const [db,cid,jwt]of [[fakeDB(),client,'invalid'],[fakeDB({active:false}),client,'valid'],[fakeDB(),other,'valid']]){
  const res=await createMailbox(db,'https://project.example.test',fetcher)(req({client_id:cid,mode:'save_draft',inquiry_id:inquiry,body:'not authorized'},jwt));assert.ok(res.status>=400);assert.equal(db.writes.length,0);
 }assert.equal(calls,0);
});
test('authorized portal status never contains token references; missing inquiry is refused',async()=>{
 const db=fakeDB(),handle=createMailbox(db,'https://project.example.test');
 const res=await handle(req({client_id:client,mode:'status'}));const status=await res.json();assert.equal(status.connected,true);assert.equal(JSON.stringify(status).includes('PRIVATE_TOKEN'),false);
 const missing=await handle(req({client_id:client,mode:'load',inquiry_id:other}));assert.equal(missing.status,409);assert.equal(db.writes.length,0);
});
test('OAuth invalid and reused states fail before provider access',async()=>{
 const db=fakeDB();let calls=0;const handle=createMailbox(db,'https://project.example.test',async()=>{calls++;throw Error('unexpected')});
 for(const state of ['bad','mailbox.'+'a'.repeat(64)]){const res=await handle(new Request('https://project.example.test/?state='+state+'&code=never-used'));assert.equal(res.status,400);}assert.equal(calls,0);
});
test('real PostgreSQL migration denies browser access, consumes state once and reserves each draft once',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create table clients(id uuid primary key);create table inquiries(id uuid,client_id uuid,unique(id,client_id));`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261031151105_client_mailbox.sql',import.meta.url),'utf8'));
 await db.exec(`insert into clients values('${client}'),('${other}');insert into auth.users values('${actor}');insert into inquiries values('${inquiry}','${client}');insert into client_mailboxes(client_id,expected_email,connected_email)values('${client}','owner@example.test','owner@example.test');insert into client_email_threads(client_id,inquiry_id,recipient,subject)values('${client}','${inquiry}','lead@example.test','Hello');insert into client_email_drafts(client_id,inquiry_id,actor_id,body,revision)values('${client}','${inquiry}','${actor}','One email','${revision}');`);
 const first=(await db.query(`select client_mailbox_claim_send('${client}','${inquiry}','${actor}','${revision}') v`)).rows[0].v;
 assert.equal(first.claimed,true);assert.equal(first.message.status,'unknown');
 const again=(await db.query(`select client_mailbox_claim_send('${client}','${inquiry}','${actor}','${revision}') v`)).rows[0].v;assert.equal(again.claimed,false);assert.equal(again.message.id,first.message.id);
 await db.exec(`update client_email_drafts set revision='${other}';`);
 await assert.rejects(db.query(`select client_mailbox_claim_send('${client}','${inquiry}','${actor}','${other}')`),/send_uncertain/);
 await db.exec(`insert into client_mailbox_oauth(state_hash,client_id,actor_id,generation,verifier,return_to) values('one','${client}','${actor}','${revision}','private','https://crm.example.test');`);
 assert.ok((await db.query(`select client_mailbox_consume_state('one') v`)).rows[0].v);
 assert.equal((await db.query(`select client_mailbox_consume_state('one') v`)).rows[0].v,null);
 await db.exec('set role authenticated');
 for(const t of ['client_mailboxes','client_mailbox_oauth','client_email_threads','client_email_drafts','client_email_messages'])await assert.rejects(db.query('select * from '+t),/permission denied/);
 await assert.rejects(db.query(`select client_mailbox_consume_state('one')`),/permission denied/);
 await db.exec('reset role');
 await assert.rejects(db.query(`insert into client_email_threads(client_id,inquiry_id,recipient,subject)values('${other}','${inquiry}','x@example.test','cross client')`),/foreign key/);
 }finally{await db.close();}
});
test('wrong Google mailbox never stores a refresh token or changes its connection',async()=>{
 const db=fakeDB();db.rpc=async(name)=>name==='client_mailbox_consume_state'?{data:{actor_id:actor,client_id:client,generation:revision,verifier:'private',return_to:'https://crm.example.test/portal/inquiries'}}:name==='get_secret'?{data:'oauth-config'}:{error:Error('unexpected secret write')};
 const provider=async url=>Response.json(url.includes('/token')?{access_token:'private-access',refresh_token:'private-refresh',scope:SCOPES.join(' ')}:{emailAddress:'someone-else@example.test'});
 const response=await createMailbox(db,'https://project.example.test',provider)(new Request('https://project.example.test/?state=mailbox.'+'a'.repeat(64)+'&code=code'));
 assert.equal(response.status,303);assert.match(response.headers.get('location'),/mailbox=wrong_google_account/);assert.equal(db.writes.length,0);
});
test('ambiguous provider send stays uncertain; repeating the saved revision does not resend',async()=>{
 const db=fakeDB();db.tables.client_email_threads.push({id:other,client_id:client,inquiry_id:inquiry,recipient:'lead@example.test',subject:'Hello'});
 let claims=0,sends=0;const message={id:revision,client_id:client,thread_id:other,actor_id:actor,request_id:revision,rfc_message_id:'<crm-test@example.test>',sender:'owner@example.test',recipient:'lead@example.test',subject:'Hello',body:'Test',status:'unknown'};
 db.rpc=async name=>name==='get_secret'?{data:'private'}:name==='client_mailbox_claim_send'?{data:{claimed:claims++===0,message}}:{data:null};
 const provider=async url=>{if(url.includes('/token'))return Response.json({access_token:'private'});sends++;throw Error('timeout after provider accepted');};
 const handle=createMailbox(db,'https://project.example.test',provider);
 for(let i=0;i<2;i++){const r=await handle(req({client_id:client,mode:'send',inquiry_id:inquiry,revision}));assert.equal(r.status,200);assert.equal((await r.json()).send_status,'unknown');}assert.equal(sends,1);
});

test('mailbox connection fails closed without its separate external OAuth app',async()=>{
 const db=fakeDB({member:true});
 db.tables.app_settings=[{key:'client_mailbox_origins',value:['https://crm.example.test']}];
 const requested=[];db.rpc=async(name,args)=>{assert.equal(name,'get_secret');requested.push(args.secret_name);return {data:null,error:null};};
 const response=await createMailbox(db,'https://project.example.test')(req({client_id:client,mode:'connect',origin:'https://crm.example.test'}));
 assert.equal(response.status,409);assert.equal((await response.json()).error,'oauth_not_configured');
 assert.deepEqual(requested.sort(),['CLIENT_MAILBOX_GOOGLE_CLIENT_ID','CLIENT_MAILBOX_GOOGLE_CLIENT_SECRET']);
 assert.equal(db.writes.length,0);
});
