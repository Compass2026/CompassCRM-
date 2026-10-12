import {websiteHost} from '../ga4-performance/metrics.ts';
export {websiteHost};
export const SOURCE='DataForSEO (unreviewed index)';
export const SUMMARY_COVERAGE='Live external index; subdomains and indirect links included';
export const HISTORY_COVERAGE='Monthly discoveries and losses; subdomains included';
const count=(n:unknown)=>{if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0||n>1e12)throw new Error('invalid_metrics');return n;};
export function providerResult(raw:unknown,host:string,kind:string) {
 // deno-lint-ignore no-explicit-any
 const r=raw as any,t=r?.tasks?.[0];
 if(r?.status_code!==20000||r?.tasks?.length!==1||t?.status_code!==20000||t?.result?.length!==1)throw new Error('provider_result_failed');
 if(t.data?.target!==host||t.result[0]?.target!==host||t.data?.function!==kind||typeof t.id!=='string')throw new Error('response_identity_mismatch');
 return {result:t.result[0],task_id:t.id,cost:Number(t.cost??0)};
}
export function summaryMetrics(raw:unknown,host:string) {
 const {result,...receipt}=providerResult(raw,host,'summary');
 const values={backlinks_total:count(result.backlinks),referring_domains:count(result.referring_domains)};
 if(values.referring_domains>values.backlinks_total)throw new Error('invalid_metrics');
 return {...receipt,values};
}
export function historyMetrics(raw:unknown,host:string,start:string,end:string) {
 const {result,...receipt}=providerResult(raw,host,'timeseries_new_lost_summary');
 if(result.date_from!==start||result.date_to!==end||result.group_range!=='month'||!Array.isArray(result.items)||result.items_count!==result.items.length)throw new Error('incomplete_history');
 if(!result.items.length)throw new Error('incomplete_history');
 const seen=new Set<string>();
 const months=result.items.map((item:{date:string;new_backlinks:number;lost_backlinks:number})=>{
  const date=item.date?.slice(0,10),first=date?.slice(0,7)+'-01';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<start||date>end||seen.has(date))throw new Error('incomplete_history');
  const last=new Date(first+'T00:00:00Z');last.setUTCMonth(last.getUTCMonth()+1);last.setUTCDate(0);
  if(last.toISOString().slice(0,10)!==date)throw new Error('incomplete_history');
  seen.add(date);return {start:first,end:date,values:{links_new:count(item.new_backlinks),links_lost:count(item.lost_backlinks)}};
 });
 return {...receipt,months:months.sort((a:{start:string},b:{start:string})=>a.start.localeCompare(b.start))};
}
