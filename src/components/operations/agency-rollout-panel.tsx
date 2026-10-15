'use client';
import { useActionState, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ClipboardCheck, History } from 'lucide-react';
import { saveRolloutReview } from '@/app/agency-rollout-actions';
import { blankRequirements, buildRolloutScorecard, REQUIREMENTS, STAGES, STAGE_LABELS, type RolloutReview, type RolloutBrand, type RolloutHealth } from '@/lib/agency-rollout';
import type { OperationsV2 } from '@/lib/operations-readiness';

const tones:Record<RolloutHealth,string>={current:'bg-emerald-50 text-emerald-800',attention:'bg-amber-50 text-amber-900',blocked:'bg-red-50 text-red-800',unknown:'bg-slate-100 text-slate-600'};
const fieldClass='mt-1 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800';
const when=(value:string)=>new Date(value).toLocaleString('en-US',{timeZone:'America/Chicago',dateStyle:'medium',timeStyle:'short'})+' CT';
function Field({label,name,value='',type='text',required=false}:{label:string;name:string;value?:string;type?:string;required?:boolean}) {
 return <label className="block min-w-0 text-xs font-medium text-slate-600">{label}<input className={fieldClass} name={name} type={type} defaultValue={value} required={required} maxLength={name==='owner'?200:2000}/></label>;
}
function ReviewForm({clientId,brandId,review}:{clientId:string;brandId:string|null;review:RolloutReview|null}) {
 const [result,action,pending]=useActionState(saveRolloutReview,{});
 const requirements=review?.requirements??blankRequirements();
 return <form action={action} className="mt-4 space-y-4 rounded-xl border border-blue-200 bg-blue-50/40 p-4" data-rollout-form>
  <input type="hidden" name="client_id" value={clientId}/><input type="hidden" name="brand_workspace_id" value={brandId??''}/><input type="hidden" name="version" value={(review?.version??0)+1}/>
  <p className="text-sm font-semibold text-navy-900">Record an operating review</p>
  <p className="text-xs leading-5 text-slate-600">Use references to the agreed scope and actual proof. Optional or excluded items need a reason, decision reference and review trigger. This saves review history only.</p>
  <div className="grid gap-3 sm:grid-cols-2">
   <label className="text-xs font-medium text-slate-600">Accepted stage<select name="stage" defaultValue={review?.stage??'unassessed'} className={fieldClass}>{STAGES.map(s=><option key={s} value={s}>{STAGE_LABELS[s]}</option>)}</select></label>
   <Field label="Responsible owner / role" name="owner" value={review?.owner} required/>
   <Field label="Next action" name="next_action" value={review?.next_action} required/>
   <Field label="Reason for this review" name="reason" required/>
   <Field label="Agreed scope reference" name="scope_ref" value={review?.scope_ref}/>
   <Field label="Configuration evidence reference" name="configuration_ref" value={review?.configuration_ref}/>
  </div>
  <div className="space-y-2">{REQUIREMENTS.map(def=>{
   const row=requirements.find(r=>r.key===def.key)!;
   return <details key={def.key} className="rounded-xl border border-slate-200 bg-white p-3">
    <summary className="cursor-pointer text-sm font-medium text-navy-900">Layer {def.layer} · {def.label}</summary>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
     <label className="text-xs font-medium text-slate-600">Applicability<select name={def.key+'.applicability'} defaultValue={row.applicability} className={fieldClass}>{['unknown','required','optional','excluded'].map(v=><option key={v} value={v}>{v==='unknown'?'Not decided':v}</option>)}</select></label>
     <label className="text-xs font-medium text-slate-600">Evidence state<select name={def.key+'.state'} defaultValue={row.state} className={fieldClass}>{['unknown','current','attention','blocked'].map(v=><option key={v} value={v}>{v}</option>)}</select></label>
     <Field label="Evidence / scope-decision reference" name={def.key+'.evidence_ref'} value={row.evidence_ref}/>
     <Field label="Measurement period / context" name={def.key+'.period'} value={row.period}/>
     <Field label="Checked at (ISO time with timezone)" name={def.key+'.checked_at'} value={row.checked_at}/>
     <Field label="Review expires at (ISO time with timezone)" name={def.key+'.valid_until'} value={row.valid_until}/>
     <Field label="Scope exception reason" name={def.key+'.reason'} value={row.reason}/>
     <Field label="Exception review trigger" name={def.key+'.review_trigger'} value={row.review_trigger}/>
     <Field label="Responsible owner / role" name={def.key+'.owner'} value={row.owner}/>
     <Field label="Next action" name={def.key+'.next_action'} value={row.next_action}/>
    </div>
   </details>;
  })}</div>
  <details className="rounded-xl border border-slate-200 bg-white p-3">
   <summary className="cursor-pointer text-sm font-medium text-navy-900">Pilot and recurring-operation acceptance</summary>
   <p className="mt-2 text-xs leading-5 text-slate-600">Pilot proof includes the approved keyword, content, destination, live URL, publication receipt and attributable measurement. Operating requires two consecutive completed seven-day delivery cycles and admin acceptance.</p>
   <div className="mt-3 grid gap-3 sm:grid-cols-2">
    <Field label="Full pilot-cycle evidence reference" name="pilot_ref" value={review?.pilot_ref}/>
    <Field label="First delivery-cycle start" name="cycle_one_start" type="date" value={review?.cycle_one_start??''}/>
    <Field label="First cycle evidence reference" name="cycle_one_ref" value={review?.cycle_one_ref}/>
    <Field label="Second delivery-cycle start" name="cycle_two_start" type="date" value={review?.cycle_two_start??''}/>
    <Field label="Second cycle evidence reference" name="cycle_two_ref" value={review?.cycle_two_ref}/>
   </div>
   <label className="mt-3 flex gap-2 text-xs text-slate-700"><input type="checkbox" name="accepted" defaultChecked={review?.accepted}/>I accept the recurring workflow based on these completed cycles.</label>
  </details>
  <label className="flex gap-2 text-xs text-slate-700"><input type="checkbox" name="critical_clear"/>I checked current exceptions and found no unresolved critical marketing incident in this scope.</label>
  {result.error&&<p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{result.error}</p>}
  {result.ok&&<p role="status" className="text-sm text-emerald-800">Review saved. History and scorecard updated.</p>}
  <button type="submit" disabled={pending} className="rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{pending?'Saving review…':'Save review'}</button>
 </form>;
}

export function AgencyRolloutPanel({data,reviews,brands}:{data:OperationsV2;reviews:RolloutReview[]|null;brands:RolloutBrand[]|null}) {
 const [stage,setStage]=useState('all'),[health,setHealth]=useState('all');
 const portfolio=buildRolloutScorecard(data,reviews,brands);
 const visible=portfolio.filter(c=>(stage==='all'||c.stage===stage)&&(health==='all'||c.health===health));
 return <section role="tabpanel" className="space-y-4" data-agency-rollout>
  <div className="flex flex-wrap items-start justify-between gap-3">
   <div><h3 className="flex items-center gap-2 text-lg font-semibold text-navy-900"><ClipboardCheck className="size-5 text-orange-600"/>Agency rollout scorecard</h3>
    <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-600">Accepted rollout stage and current marketing health are separate. Setup counts never establish operation. Standard 1.0; billing, SMS and portal remain separate release tracks.</p></div>
   <Link href="/production" className="inline-flex items-center gap-1 text-xs font-semibold text-blue-800">Delivery planner<ArrowRight className="size-3"/></Link>
  </div>
  {(reviews===null||brands===null)&&<p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Rollout history or brand inventory is unavailable. No stage or health conclusion is made. Editing is disabled until a complete read succeeds.</p>}
  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">{STAGES.map(s=><button type="button" key={s} aria-pressed={stage===s} onClick={()=>setStage(stage===s?'all':s)} className={'rounded-xl border p-3 text-left '+(stage===s?'border-blue-400 bg-blue-50':'border-slate-200 bg-white')}>
   <span className="block text-xl font-semibold text-navy-900">{portfolio.filter(c=>c.stage===s).length}</span><span className="text-xs text-slate-600">{STAGE_LABELS[s]}</span></button>)}</div>
  <div className="flex flex-wrap items-center gap-3 text-xs">
   <button type="button" onClick={()=>{setStage('all');setHealth('all');}} className="rounded-lg bg-slate-100 px-3 py-2 font-semibold text-slate-700">Show all</button>
   <label>Health <select aria-label="Filter rollout health" value={health} onChange={e=>setHealth(e.target.value)} className="ml-2 rounded-lg border border-slate-300 bg-white p-2">{['all','current','attention','blocked','unknown'].map(s=><option key={s} value={s}>{s}</option>)}</select></label>
   <span className="text-slate-500">{visible.length} of {portfolio.length} selected clients</span>
  </div>
  {visible.map(client=><article key={client.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" data-rollout-client={client.id}>
   <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50 p-4">
    <Link href={'/clients/'+client.id+'/growth'} className="font-semibold text-navy-900 hover:underline">{client.name}</Link>
    <div className="flex gap-2 text-xs"><span className="rounded-full bg-blue-50 px-3 py-1 font-semibold text-blue-900">{STAGE_LABELS[client.stage]}</span><span className={'rounded-full px-3 py-1 font-semibold capitalize '+tones[client.health]}>{client.health}</span></div>
   </div>
   <div className="space-y-3 p-4">{client.scopes.map(scope=><details key={scope.id??'parent'} className="rounded-xl border border-slate-200 p-3" data-rollout-scope={scope.id??'parent'}>
    <summary className="cursor-pointer text-sm text-slate-700"><strong>{scope.name}</strong> · {STAGE_LABELS[scope.stage]} · <span className="capitalize">{scope.health}</span></summary>
    <div className="mt-3 space-y-3">
     <p className="text-xs text-slate-600">{scope.review?`${scope.verified} / ${scope.required} required evidence reviews current. Last reviewed ${when(scope.review.reviewed_at)}.`:'No operating review recorded. Existing setup evidence remains available in the other Control Center views.'}</p>
     <p className="text-xs text-slate-600"><strong>Owner:</strong> {scope.review?.owner??'Unassigned'} · <strong>Next:</strong> {scope.review?.next_action??'Confirm agreed scope and record the first review.'}</p>
     {scope.critical.length>0&&<p className="rounded-lg bg-red-50 p-3 text-xs text-red-800">{scope.critical.length} unresolved critical marketing exception(s). Inspect the Action queue before advancing.</p>}
     {scope.id&&<p className="text-xs text-slate-500">This brand needs its own evidence. A shared parent GBP must be reviewed under Parent / shared services and explicitly excluded here with its decision reference.</p>}
     {scope.review&&<ul className="divide-y divide-slate-100">{scope.review.requirements.map(r=><li key={r.key} className="py-2 text-xs leading-5 text-slate-600"><strong>{REQUIREMENTS.find(d=>d.key===r.key)?.label}:</strong> {r.applicability} · {r.state}<br/>{r.evidence_ref&&<>Evidence: {r.evidence_ref}<br/></>}{r.period&&<>Period: {r.period}<br/></>}{r.valid_until&&<>Review expiry: {r.valid_until}<br/></>}{r.reason&&<>Reason: {r.reason} · Revisit: {r.review_trigger}<br/></>}{r.owner&&<>Owner: {r.owner} · Next: {r.next_action}</>}</li>)}</ul>}
     <details className="rounded-lg bg-slate-50 p-3"><summary className="cursor-pointer text-xs font-semibold text-slate-700"><History className="mr-1 inline size-3"/>Review history ({scope.history.length})</summary>
      <ol className="mt-2 space-y-3">{scope.history.map(h=><li key={h.id} className="break-words text-xs leading-5 text-slate-600">v{h.version} · {STAGE_LABELS[h.stage]} · {when(h.reviewed_at)}<br/>{h.reason}<br/>Reviewer: {h.reviewed_by}<details><summary className="cursor-pointer text-blue-800">Evidence snapshot</summary><pre className="mt-2 whitespace-pre-wrap break-words text-[11px]">{JSON.stringify(h,null,2)}</pre></details></li>)}</ol>
     </details>
     {reviews!==null&&brands!==null&&<details><summary className="cursor-pointer text-xs font-semibold text-blue-800">Record / update review</summary><ReviewForm key={scope.review?.version??0} clientId={client.id} brandId={scope.id} review={scope.review}/></details>}
    </div>
   </details>)}</div>
  </article>)}
  {!visible.length&&<p className="rounded-xl border border-dashed border-slate-300 p-5 text-sm text-slate-600">No clients match these filters.</p>}
 </section>;
}
