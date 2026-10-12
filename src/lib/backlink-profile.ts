import {backlinkText,backlinkUuid,httpUrl} from './backlinks.ts';
import {agencyToday,validDate,type MeasurementInput} from './reporting.ts';
export function parseBacklinkProfile(clientId:string,form:FormData,allowedSites:string[],today=agencyToday()):MeasurementInput[] {
 const target=httpUrl(backlinkText(form,'website',2000));
 const host=new URL(target).hostname.toLowerCase().replace(/^www\./,'');
 if(!allowedSites.some(site=>{try{return new URL(site).hostname.toLowerCase().replace(/^www\./,'')===host;}catch{return false;}}))throw new Error('Choose a website belonging to this client or brand.');
 const observed=backlinkText(form,'observed_on',10),start=backlinkText(form,'window_start',10);
 if(!validDate(observed)||observed>today)throw new Error('Choose a measurement date ending today or earlier.');
 const provider=backlinkText(form,'provider',100),coverage=backlinkText(form,'coverage',150),evidence=backlinkText(form,'evidence',1000);
 if(!provider||!coverage||!evidence)throw new Error('Add the provider, report coverage and evidence.');
 const rows:MeasurementInput[]=[];
 for(const metric of ['backlinks_total','referring_domains','links_new','links_lost'] as const) {
  const raw=backlinkText(form,metric,20);
  if(raw==='')continue;
  const value=Number(raw);
  if(!/^\d+$/.test(raw)||!Number.isSafeInteger(value)||value>1e12)throw new Error('Use whole nonnegative counts. Leave unavailable values blank.');
  const window=metric==='links_new'||metric==='links_lost';
  if(window&&(!validDate(start)||start>observed))throw new Error('New and lost links need the provider report’s start date.');
  rows.push({id:backlinkUuid(backlinkText(form,`${metric}_id`,36)),client_id:backlinkUuid(clientId),metric,source:provider,scope:`${host} | ${coverage}`,platform:'none',channel:'none',context:'existing_client',report_period:`${observed.slice(0,7)}-01`,window_start:window?start:observed,window_end:observed,status:'measured',value,evidence,meaning:'Counts from the stated backlink provider and report coverage. Provider indexes differ; managed placements are tracked separately. New and lost counts are reported directly, never inferred from net growth.',next_action:'Review relevant opportunities and verify priority links. Repeat the same provider and coverage for a comparable profile.'});
 }
 if(!rows.length)throw new Error('Enter at least one measured count. Unknown is not zero.');
 const total=rows.find(r=>r.metric==='backlinks_total')?.value,domains=rows.find(r=>r.metric==='referring_domains')?.value;
 if(total!=null&&domains!=null&&domains>total)throw new Error('Referring websites cannot exceed backlinks in the same report.');
 return rows;
}
