'use server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireTeamMember } from '@/lib/team';
import { isUuid } from '@/lib/tasks';
import { REQUIREMENTS, ROLLOUT_STANDARD, STAGES, validateRolloutWrite, type RolloutStage, type RolloutWrite, type RequirementReview } from '@/lib/agency-rollout';
import { loadIntegrationHealth } from '@/lib/integration-health-loader';

export async function saveRolloutReview(_previous: {ok?:boolean; error?:string}, form: FormData): Promise<{ok?:boolean; error?:string}> {
  const db=await createClient();
  await requireTeamMember(db);
  const text=(key:string)=>String(form.get(key) ?? '').trim();
  const clientId=text('client_id'), brandId=text('brand_workspace_id') || null;
  if (!isUuid(clientId) || (brandId && !isUuid(brandId))) return {error:'Choose a valid client and brand.'};
  const q=db.from('agency_rollout_reviews').select('*').eq('client_id',clientId).order('version',{ascending:false}).limit(1);
  const previous=await (brandId ? q.eq('brand_workspace_id',brandId) : q.is('brand_workspace_id',null)).maybeSingle();
  if (previous.error) return {error:'Review history is unavailable. Nothing was saved.'};
  const requirements=REQUIREMENTS.map(({key})=>Object.fromEntries(['applicability','state','evidence_ref','checked_at','valid_until','period','reason','review_trigger','owner','next_action']
    .map(field=>[field,text(key+'.'+field)]).concat([['key',key]]))) as RequirementReview[];
  const write:RolloutWrite={client_id:clientId,brand_workspace_id:brandId,version:Number(text('version')),standard_version:ROLLOUT_STANDARD,
    stage:text('stage') as RolloutStage,requirements,scope_ref:text('scope_ref'),configuration_ref:text('configuration_ref'),pilot_ref:text('pilot_ref'),
    cycle_one_start:text('cycle_one_start')||null,cycle_one_ref:text('cycle_one_ref'),cycle_two_start:text('cycle_two_start')||null,cycle_two_ref:text('cycle_two_ref'),
    owner:text('owner'),next_action:text('next_action'),reason:text('reason'),critical_clear:form.get('critical_clear')==='on',accepted:form.get('accepted')==='on'};
  const now=new Date().toISOString();
  const error=validateRolloutWrite(write,previous.data,now);
  if(error)return {error};
  // Re-read source evidence before advancing, never trust a browser's green card.
  if(STAGES.indexOf(write.stage)>STAGES.indexOf(previous.data?.stage??'unassessed') && STAGES.indexOf(write.stage)>=3) {
    const sources=await loadIntegrationHealth(db,[clientId],now);
    const brand=brandId ? await db.from('client_brand_workspaces').select('client_id,gsc_property,ga4_property').eq('id',brandId).eq('client_id',clientId).maybeSingle() : null;
    if(brandId && !brand?.data)return {error:'Brand evidence could not be verified.'};
    for(const key of ['gsc','ga4','gbp'] as const) {
      if(!requirements.some(r=>r.key===key&&r.applicability==='required'))continue;
      const evidence=sources.find(e=>e.source===key);
      const property=brand?.data?.[key==='gsc'?'gsc_property':'ga4_property'];
      const matches=evidence?.scopes.filter(s=>s.property===property)??[];
      const verified=brandId ? key!=='gbp'&&!!property&&matches.length===1&&matches[0].health==='verified' : evidence?.state==='verified';
      if(!verified)return {error:key.toUpperCase()+' provider evidence is not verified for this exact scope. Resolve it before advancing; shared GBP belongs to the parent.'};
    }
  }
  const result=await db.from('agency_rollout_reviews').insert(write);
  if(result.error)return {error:result.error.code==='40001'||result.error.code==='23505'?'This review changed. Reload before saving.':result.error.message};
  revalidatePath('/production/health');
  return {ok:true};
}
