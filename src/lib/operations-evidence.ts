import { reportingHost } from "./integration-health.ts";
import type { Alert, ReadinessCheck } from "./operations-readiness";
import { readinessState, type OnboardingGap, type OnboardingRow } from "./client-onboarding.ts";

type Row={client_id:string};
export type OperationalCard={key:string;clientId:string;label:string;state:"recorded"|"attention"|"setup"|"unknown";evidence:string;lastAttempt:string|null;lastEvidence:string|null;nextAction:string;href:string};
export type OperationalInput={
 clients:{id:string;name:string;website_url:string|null}[];
 keywords:(Row & {id:string;is_active:boolean;is_tracked:boolean;service_id:string|null;intent:string|null;target_url:string|null})[]|null;
 rankings:(Row & {keyword_id:string;checked_at:string|null;result_type:string|null})[]|null;
 rankRuns:(Row & {id:string;status:string;started_at:string;completed_at:string|null;checks_count:number|null})[]|null;
 backlinks:(Row & {id:string;stage:string;due_on:string|null;next_action:string})[]|null;
 backlinkChecks:{opportunity_id:string;observed_on:string;recorded_at:string;result:string}[]|null;
 backlinkRuns:(Row & {host:string;status:string;created_at:string;finished_at:string|null;results:unknown})[]|null;
 profileMeasures:(Row & {scope:string;source:string;metric:string;window_end:string;created_at:string})[]|null;
 socialAccounts:(Row & {id:string;platform:string;external_account_id:string|null;publish_account_id:string|null})[]|null;
 social:(Row & {id:string;platform:string;review_status:string;publish_status:string;last_attempt_at:string|null;scheduled_at:string|null;published_at:string|null;published_url:string|null;external_post_id:string|null})[]|null;
 notifications:(Row & {id:string;status:string;block_reason:string|null;last_attempt_at:string|null;delivered_at:string|null;provider_status:string|null;next_attempt_at:string|null;created_at:string})[]|null;
 billing:(Row & {status:string;livemode:boolean;checked_at:string;attention_reasons:string[];warnings:string[]})[]|null;
 sites:(Row & {id:string;url:string|null;controlled_by_compass:boolean;vercel_project:string|null;repo_url:string|null;last_pushed_at:string|null})[]|null;
 brands:(Row & {id:string;name:string;website_url:string;service_ids:string[];claim_ids:string[];blog_site_id:string|null;facebook_account_id:string|null;status:string})[]|null;
 services:(Row & {id:string;status:string})[]|null;
 claims:(Row & {id:string;status:string})[]|null;
 authority:{client_id:string|null;finished_at:string|null;inventory_fetched_at:string|null;inventory_stale:boolean|null;stale_sections:string[]|null}[]|null;
 // New Client Onboarding rows (client_onboarding_overview); undefined = not loaded, no check.
 onboarding?:OnboardingRow[]|null;
 onboardingGaps?:OnboardingGap[]|null;
 now:string;
};
export type OperationalEvidence={cards:OperationalCard[];alerts:Alert[];checks:Record<string,ReadinessCheck[]>};
const time=(s:string|null|undefined)=>s ? Date.parse(s) : NaN;
const latest=<T>(rows:T[],key:(r:T)=>string|null)=>rows.toSorted((a,b)=>time(key(b))-time(key(a)))[0];
const objects=(v:unknown)=>Array.isArray(v)?v.filter((x):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x)):[];
export function buildOperationalEvidence(input:OperationalInput):OperationalEvidence {
 const cards:OperationalCard[]=[],alerts:Alert[]=[],checks:Record<string,ReadinessCheck[]>={};
 const clock=time(input.now),day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(input.now));
 const valid=(s:string|null|undefined)=>Number.isFinite(time(s))&&time(s)<=clock;
 const fresh=(s:string|null|undefined,days:number)=>valid(s)&&clock-time(s)<=days*86400000;
 for(const client of input.clients){
  const id=client.id,base=`/clients/${id}`,own=<T extends Row>(rows:T[]|null)=>rows?.filter(r=>r.client_id===id)??[];
  checks[id]=[];
  const warn=(key:string,title:string,detail:string,href:string,severity:Alert['severity']='attention')=>alerts.push({id:`${id}:ops:${key}`,clientId:id,clientName:client.name,severity,title,detail,href});
  const card=(key:string,label:string,state:OperationalCard['state'],evidence:string,lastAttempt:string|null,lastEvidence:string|null,nextAction:string,href:string)=>{
   cards.push({key,clientId:id,label,state,evidence,lastAttempt,lastEvidence,nextAction,href});
   if(state==='attention'||state==='unknown')warn(key,label+' needs attention',evidence+' Next: '+nextAction,href);
  };
  const check=(key:string,label:string,state:ReadinessCheck['state'],href:string,detail:string)=>checks[id].push({key,label,state,href,detail});
  const keys=own(input.keywords).filter(k=>k.is_active&&k.is_tracked),rankRows=own(input.rankings),run=latest(own(input.rankRuns),r=>r.started_at);
  if(input.rankings===null||input.rankRuns===null||input.keywords===null)card('rankings','Keyword rankings','unknown','Ranking evidence could not be read completely.',null,null,'Reload source evidence and investigate access if it persists.',base+'/keywords');
  else {
   const covered=keys.filter(k=>['organic','map_pack'].every(type=>rankRows.some(r=>r.keyword_id===k.id&&r.result_type===type&&fresh(r.checked_at,14)))).length;
   const last=latest(rankRows.filter(r=>valid(r.checked_at)),r=>r.checked_at)?.checked_at??null;
   const state=!keys.length?'setup':!run||run.status!=='complete'||!valid(run.started_at)||!valid(run.completed_at)||time(run.completed_at)<time(run.started_at)||!run.checks_count||covered!==keys.length?'attention':'recorded';
   card('rankings','Keyword rankings',state,`${covered} of ${keys.length} tracked keywords have organic and map observations within 14 days. Latest run: ${run?.status??'not recorded'}. A not-found position is a valid observation, not a zero ranking.`,run?.started_at??null,last,'Review missing checks and the latest rank run.',base+'/keywords');
  }
  const opportunities=own(input.backlinks),brands=own(input.brands),hosts=[...new Set([client,...brands].map(b=>reportingHost(b.website_url)).filter((h):h is string=>!!h))];
  const profileRuns=own(input.backlinkRuns),measures=own(input.profileMeasures);
  if([input.backlinks,input.backlinkChecks,input.backlinkRuns,input.profileMeasures,input.brands].some(x=>x===null))card('backlinks','Backlinks','unknown','Backlink source or placement evidence is unavailable.',null,null,'Review source access before interpreting counts.',base+'/backlinks');
  else {
   const hostStatus=hosts.map(host=>{
    const r=latest(profileRuns.filter(r=>r.host===host),r=>r.created_at),outcomes=objects(r?.results);
    const measured=latest(measures.filter(m=>m.scope.split(' | ')[0]===host&&m.metric==='backlinks_total'&&m.source==='DataForSEO (unreviewed index)'),m=>m.window_end);
    const good=outcomes.some(o=>o.kind==='summary'&&['imported','unchanged'].includes(String(o.status)));
    const state=!r?'missing':r.status!=='completed'||outcomes.some(o=>o.status==='failed')?'partial':!good||!fresh(r.finished_at,8)||!measured||!fresh(measured.window_end,8)?'unverified':'current';
    return {host,state,run:r,measured};
   });
   card('backlinks','Backlinks',!hosts.length?'setup':hostStatus.every(h=>h.state==='current')?'recorded':'attention',(hosts.length?hostStatus.map(h=>`${h.host}: ${h.state}`).join('; '):'No configured website host')+`. ${opportunities.filter(o=>o.stage==='research').length} opportunities in research. Provider index counts do not prove earned placements.`,latest(profileRuns,r=>r.created_at)?.created_at??null,latest(measures.filter(m=>valid(m.created_at)),m=>m.created_at)?.created_at??null,'Review incomplete provider history and prioritize the next backlink action.',base+'/backlinks');
   const due=opportunities.filter(o=>o.stage!=='closed'&&o.due_on&&o.due_on<=day);
   if(due.length)warn('backlinks-due','Backlink follow-ups due',`${due.length} open opportunities have a due date on or before ${day}. Review their recorded next actions.`,base+'/backlinks');
   const unresolved=opportunities.filter(o=>o.stage==='placed'&&(()=>{const c=latest(input.backlinkChecks!.filter(c=>c.opportunity_id===o.id),c=>c.observed_on);return !c||c.result!=='live'||!fresh(c.observed_on,30);})());
   if(unresolved.length)warn('backlinks-check','Reported placements need verification',`${unresolved.length} placements lack a current live check. Review the latest evidence before claiming a live backlink.`,base+'/backlinks');
   if(opportunities.some(o=>o.stage==='research'))warn('backlinks-research','Backlink research ready for review',`${opportunities.filter(o=>o.stage==='research').length} researched opportunities await prioritization. Review relevance before approving outreach.`,base+'/backlinks','setup');
  }
  const posts=own(input.social),accounts=own(input.socialAccounts);
  if(input.social===null)card('social','Social publishing','unknown','Social review and delivery records unavailable.',null,null,'Reload social workflow evidence.',base+'/social');
  else {
   const problems=posts.filter(p=>p.publish_status==='failed'||(p.publish_status==='publishing'&&(!valid(p.last_attempt_at)||clock-time(p.last_attempt_at)>30*60000))||(p.publish_status==='scheduled'&&valid(p.scheduled_at)&&clock-time(p.scheduled_at)>35*60000));
   const published=posts.filter(p=>p.publish_status==='published'&&valid(p.published_at)&&(p.external_post_id||p.published_url));
   card('social','Social publishing',problems.length?'attention':published.length?'recorded':'setup',`${published.length} publication receipts; ${posts.filter(p=>p.review_status==='in_review').length} awaiting human review; ${problems.length} unresolved delivery attempts. Receipt presence is not a live URL probe.`,latest(posts.filter(p=>valid(p.last_attempt_at)),p=>p.last_attempt_at)?.last_attempt_at??null,latest(published,p=>p.published_at)?.published_at??null,'Review approvals and provider evidence before scheduling or retrying.',base+'/social');
   for(const p of posts.filter(p=>p.review_status==='in_review'))warn('social-review:'+p.id,'Social post waiting for approval',`${p.platform} content requires human review.`,base+'/social/'+p.id);
   for(const p of problems)warn('social-delivery:'+p.id,'Social publication needs review',`Current state: ${p.publish_status}. Inspect the attempt and reconcile provider evidence before retrying.`,base+'/social/'+p.id,'critical');
  }
  const jobs=own(input.notifications);
  if(input.notifications===null)card('notifications','CRM Lite notifications','unknown','Notification evidence is unavailable.',null,null,'Review the inquiry notification workflow.',base+'/inquiries');
  else {
   const bad=jobs.filter(j=>['failed','blocked','unknown'].includes(j.status)),delivered=jobs.filter(j=>j.status==='sent'&&j.provider_status==='delivered'&&valid(j.delivered_at));
   const overdue=jobs.filter(j=>['pending','queued','sending','retry'].includes(j.status)&&valid(j.next_attempt_at??j.created_at)&&clock-time(j.next_attempt_at??j.created_at)>30*60000);
   card('notifications','CRM Lite notifications',bad.length||overdue.length?'attention':delivered.length?'recorded':'setup',`${delivered.length} provider-confirmed deliveries; ${bad.length} blocked, failed or uncertain jobs; ${overdue.length} overdue jobs. Sending or provider acceptance alone is not delivery.`,latest(jobs.filter(j=>valid(j.last_attempt_at)),j=>j.last_attempt_at)?.last_attempt_at??null,latest(delivered,j=>j.delivered_at)?.delivered_at??null,'Review consent, sender status and the delivery receipt. Preserve SMS approval gates.',base+'/inquiries');
  }
  const bills=own(input.billing).filter(b=>b.livemode),bill=latest(bills,b=>b.checked_at);
  card('billing','Billing reconciliation',input.billing===null?'unknown':!bill?'setup':!['healthy','repaired'].includes(bill.status)||bill.attention_reasons.length||bill.warnings.length||!fresh(bill.checked_at,2)?'attention':'recorded',input.billing===null?'Live reconciliation records unavailable.':!bill?'No live client-scoped reconciliation receipt.':`Latest live check: ${bill.status}; ${bill.attention_reasons.length} attention reasons; ${bill.warnings.length} warnings. Reconciliation does not establish a paid subscription.`,bill?.checked_at??null,bill&&['healthy','repaired'].includes(bill.status)&&valid(bill.checked_at)?bill.checked_at:null,'Review the billing reconciliation receipt and agreement before any billing action.',base+'/billing');
  if(input.billing!==null&&!bill)warn('billing-setup','Live billing reconciliation not recorded','Confirm the client billing setup and existing Stripe mapping. Do not create or charge a subscription automatically.',base+'/billing','setup');
  const sites=own(input.sites).filter(s=>s.controlled_by_compass),unmapped=sites.filter(s=>!s.vercel_project||!s.repo_url);
  card('websites','Website publishing',input.sites===null?'unknown':!sites.length?'setup':unmapped.length?'attention':'recorded',input.sites===null?'Website mappings unavailable.':`${sites.length} managed websites; ${unmapped.length} missing repo or deployment mapping. Last push is code evidence, not proof of a READY deployment or live content.`,latest(sites.filter(s=>valid(s.last_pushed_at)),s=>s.last_pushed_at)?.last_pushed_at??null,null,'Inspect the exact website deployment and published URL before the next release.',base+'/foundation');
  const services=own(input.services),claims=own(input.claims);
  const scopes=brands.length?brands:[{id:'client',name:client.name,service_ids:services.filter(s=>s.status!=="retired").map(s=>s.id),claim_ids:claims.map(c=>c.id),blog_site_id:null,status:'',website_url:client.website_url??'',facebook_account_id:null,client_id:id}];
  for(const scope of scopes){
   const prefix=brands.length?scope.name+': ':'';
   const serviceRows=services.filter(s=>scope.service_ids.includes(s.id)),claimRows=claims.filter(c=>scope.claim_ids.includes(c.id));
   const svc=scope.service_ids.length>0&&scope.service_ids.every(sid=>serviceRows.some(s=>s.id===sid&&s.status==='approved'));
   const clm=scope.claim_ids.length>0&&scope.claim_ids.every(cid=>claimRows.some(c=>c.id===cid&&c.status==='confirmed'));
   check('services:'+scope.id,prefix+'Approved services',input.brands===null||input.services===null?'unknown':svc?'recorded':serviceRows.length?'waiting':'missing',base+'/services',`${serviceRows.filter(s=>s.status==='approved').length} approved of ${scope.service_ids.length} scoped services.`);
   check('claims:'+scope.id,prefix+'Confirmed claims',input.brands===null||input.claims===null?'unknown':clm?'recorded':claimRows.length?'waiting':'missing',base+'/foundation',`${claimRows.filter(c=>c.status==='confirmed').length} confirmed of ${scope.claim_ids.length} scoped claims. Review factual authorization; never invent claims.`);
   const scopedKeys=keys.filter(k=>!brands.length||scope.service_ids.includes(k.service_id??''));
   const mapped=scopedKeys.filter(k=>k.intent&&k.target_url&&serviceRows.some(s=>s.id===k.service_id&&s.status==='approved'));
   check('intent:'+scope.id,prefix+'Keyword intent and owner pages',input.keywords===null||input.services===null||input.brands===null?'unknown':scopedKeys.length&&mapped.length===scopedKeys.length?'recorded':'missing',base+'/keywords',`${mapped.length} of ${scopedKeys.length} tracked keywords have intent, approved service and owner page.`);
   check('social-channel:'+scope.id,prefix+'Social channel connection',input.socialAccounts===null||input.brands===null?'unknown':accounts.some(a=>(brands.length?a.id===scope.facebook_account_id&&a.platform==='facebook':a.platform!=='google_business')&&!!a.external_account_id&&!!a.publish_account_id)?'recorded':'missing',base+'/social',brands.length?'Verify the brand-specific Facebook account. Connection does not enable or authorize publication.':'Verify the agreed social channels. Connection does not enable or authorize publication.');
   if(brands.length)check('destination:'+scope.id,prefix+'Website publishing destination',input.sites===null?'unknown':scope.blog_site_id&&sites.some(s=>s.id===scope.blog_site_id&&s.vercel_project&&s.repo_url&&reportingHost(s.url)===reportingHost(scope.website_url))?'recorded':'missing',base+'/brand','Destination must belong to this client and match the brand website. A mapping does not authorize publication.');
  }
  const authority=input.authority?.find(r=>r.client_id===id);
  check('authority','Recent Authority inventory',input.authority===null?'unknown':!authority?'missing':authority.inventory_stale!==false||authority.stale_sections?.length||!fresh(authority.inventory_fetched_at,7)?'blocked':'recorded',base+'/authority','Inventory must be current within seven days. Content still requires keyword, brand, claim and human approval gates.');
  check('baseline','Reporting baseline evidence',input.profileMeasures===null?'unknown':measures.some(m=>valid(m.window_end))?'recorded':'missing',base+'/growth','A dated measurement establishes an observed baseline, not a pre-engagement baseline or proof of growth.');
  if(input.onboarding!==undefined){const ob=readinessState(input.onboarding===null?null:input.onboarding.filter(r=>r.client_id===id),input.onboardingGaps==null?null:input.onboardingGaps.filter(g=>g.client_id===id),day);check('onboarding','New client onboarding checklist',ob.state,base+'/onboarding',ob.detail);}
 }
 return {cards,alerts,checks};
}
