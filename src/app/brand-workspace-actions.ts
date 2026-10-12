'use server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { parsePalette, WORKSPACE_LIST_FIELDS, WORKSPACE_TEXT_FIELDS } from '@/lib/brand-workspaces';
import type { Database } from '@/lib/database.types';

const str=(f:FormData,k:string)=>String(f.get(k)??'').trim();
export async function saveBrandWorkspace(clientId:string,id:string,version:number,form:FormData) {
  const db=await createClient();
  const update:Database['public']['Tables']['client_brand_workspaces']['Update']={
    name:str(form,'name'),phone:str(form,'phone'),website_url:str(form,'website_url'),
    palette:parsePalette(str(form,'palette')),
    service_ids:form.getAll('service_ids').map(String),
    claim_ids:form.getAll('claim_ids').map(String),asset_ids:form.getAll('asset_ids').map(String),
    blog_site_id:str(form,'blog_site_id')||null,facebook_account_id:str(form,'facebook_account_id')||null,
  };
  const url=new URL(update.website_url!);
  if(url.protocol!=='https:'||url.username||url.password) throw new Error('Use an HTTPS website address.');
  for(const [key] of WORKSPACE_TEXT_FIELDS) update[key]=str(form,key);
  for(const [key] of WORKSPACE_LIST_FIELDS) update[key]=str(form,key).split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const {data,error}=await db.from('client_brand_workspaces').update(update).eq('id',id).eq('client_id',clientId).eq('version',version).select('id').maybeSingle();
  if(error) throw new Error(error.message);
  if(!data) throw new Error('The brand changed or is unavailable. Reload before saving.');
  revalidatePath(`/clients/${clientId}/brand`);
}
export async function reviewBrandWorkspace(clientId:string,id:string,version:number,approved:boolean) {
  const db=await createClient();
  const {data,error}=await db.from('client_brand_workspaces').update({status:approved?'approved':'draft'})
    .eq('id',id).eq('client_id',clientId).eq('version',version).select('id').maybeSingle();
  if(error) throw new Error(error.message);
  if(!data) throw new Error('The brand changed or is unavailable. Reload and review the current version.');
  revalidatePath(`/clients/${clientId}/brand`);
}
