import type {SupabaseClient} from '@supabase/supabase-js';
import type {Database} from './database.types';
import {completeRead} from './integration-health.ts';
import {buildOperationalEvidence} from './operations-evidence.ts';
import type {OnboardingRow} from './client-onboarding';
export async function loadOperationalEvidence(db:SupabaseClient<Database>,clientIds:string[],now:string){
 if(!clientIds.length)return {cards:[],alerts:[],checks:{}};
 // Team-session RLS only. Do not read message bodies, recipients, secrets,
 // provider payloads or financial identifiers into the agency dashboard.
 const [onboarding,clients,keywords,rankings,rankRuns,backlinks,backlinkChecks,backlinkRuns,profileMeasures,social,socialAccounts,notifications,billing,sites,brands,services,claims,authority]=await Promise.all([
  db.from('client_onboarding_overview').select('*',{count:'exact'}).in('client_id',clientIds).limit(3000),
  db.from('clients').select('id,name,website_url',{count:'exact'}).in('id',clientIds).limit(3000),
  db.from('keywords').select('id,client_id,is_active,is_tracked,service_id,intent,target_url',{count:'exact'}).in('client_id',clientIds).limit(3000),
  db.from('client_growth_rankings').select('client_id,keyword_id,checked_at,result_type',{count:'exact'}).in('client_id',clientIds).limit(3000),
  db.from('rank_runs').select('id,client_id,status,started_at,completed_at,checks_count',{count:'exact'}).in('client_id',clientIds).limit(3000),
  db.from('backlink_opportunities').select('id,client_id,stage,due_on,next_action',{count:'exact'}).in('client_id',clientIds).limit(3000),
  db.from('backlink_checks').select('opportunity_id,observed_on,recorded_at,result',{count:'exact'}).limit(3000),
  db.from('backlink_profile_sync_runs').select('client_id,host,status,created_at,finished_at,results',{count:'exact'}).in('client_id',clientIds).limit(3000),
  db.from('report_measurements').select('client_id,scope,source,metric,window_end,created_at',{count:'exact'}).in('client_id',clientIds).eq('status','measured').limit(3000),
  db.from('social_posts').select('id,client_id,platform,review_status,publish_status,last_attempt_at,scheduled_at,published_at,published_url,external_post_id',{count:'exact'}).in('client_id',clientIds).limit(3000),
  db.from('social_accounts').select('id,client_id,platform,external_account_id,publish_account_id',{count:'exact'}).in('client_id',clientIds).limit(3000),
  db.from('notification_jobs').select('id,client_id,status,block_reason,last_attempt_at,delivered_at,provider_status,next_attempt_at,created_at',{count:'exact'}).in('client_id',clientIds).limit(3000),
  db.from('billing_reconciliation_results').select('client_id,status,livemode,checked_at,attention_reasons,warnings',{count:'exact'}).in('client_id',clientIds).eq('livemode',true).limit(3000),
  db.from('sites').select('id,client_id,url,controlled_by_compass,vercel_project,repo_url,last_pushed_at',{count:'exact'}).in('client_id',clientIds).limit(3000),
  db.from('client_brand_workspaces').select('id,client_id,name,website_url,service_ids,claim_ids,blog_site_id,facebook_account_id,status',{count:'exact'}).in('client_id',clientIds).limit(3000),
  db.from('services').select('id,client_id,status',{count:'exact'}).in('client_id',clientIds).limit(3000),
  db.from('claims').select('id,client_id,status',{count:'exact'}).in('client_id',clientIds).limit(3000),
  db.from('authority_latest').select('client_id,finished_at,inventory_fetched_at,inventory_stale,stale_sections',{count:'exact'}).in('client_id',clientIds).limit(3000),
 ]);
 const roster=completeRead(clients);
 if(roster===null)throw new Error('Operational client roster unavailable');
 return buildOperationalEvidence({clients:roster,keywords:completeRead(keywords),rankings:completeRead(rankings),rankRuns:completeRead(rankRuns),backlinks:completeRead(backlinks),backlinkChecks:completeRead(backlinkChecks),backlinkRuns:completeRead(backlinkRuns),profileMeasures:completeRead(profileMeasures),social:completeRead(social),socialAccounts:completeRead(socialAccounts),notifications:completeRead(notifications),billing:completeRead(billing),sites:completeRead(sites),brands:completeRead(brands),services:completeRead(services),claims:completeRead(claims),authority:completeRead(authority),onboarding:completeRead(onboarding) as OnboardingRow[]|null,now});
}
