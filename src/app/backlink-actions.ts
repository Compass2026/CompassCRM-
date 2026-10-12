"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { BACKLINK_STAGES, backlinkText, backlinkUuid, parseBacklink, parseBacklinkCheck, type BacklinkOpportunity } from "@/lib/backlinks";
import { validDate } from "@/lib/reporting";
export type BacklinkActionState={error?:string;savedId?:string};
async function teamClient(clientId:string) {
  backlinkUuid(clientId);
  const db=await createClient();
  const {data:{user}}=await db.auth.getUser();
  if(!user) throw new Error("Sign in again to continue.");
  const {data:team,error}=await db.rpc("is_team");
  if(error||!team) throw new Error("Only Compass team members can manage backlinks.");
  const {data:client}=await db.from("clients").select("id").eq("id",clientId).maybeSingle();
  if(!client) throw new Error("Client unavailable.");
  return db;
}
function refresh(clientId:string) {revalidatePath(`/clients/${clientId}/backlinks`);revalidatePath("/portal/backlinks");}
function failure(e:unknown) {return {error:e instanceof Error?e.message:"Unable to save. Try again."};}
export async function addBacklinkAction(clientId:string,_state:BacklinkActionState,form:FormData):Promise<BacklinkActionState> {
  try {
    const db=await teamClient(clientId),input=parseBacklink(clientId,form);
    const {error}=await db.from("backlink_opportunities").insert(input);
    if(error?.code==="23505") {
      const {data:existing}=await db.from("backlink_opportunities").select("*").eq("client_id",clientId).eq("id",input.id).maybeSingle();
      if(!existing||Object.entries(input).some(([k,v])=>existing[k as keyof typeof existing]!==v)) throw new Error("That source and target already have an opportunity. Open the existing record.");
    } else if(error) throw new Error(error.code==="23514"?error.message:"Opportunity could not be saved. Your entry is kept for retry.");
    refresh(clientId); return {savedId:input.id};
  }catch(e){return failure(e);}
}
export async function updateBacklinkAction(clientId:string,id:string,_state:BacklinkActionState,form:FormData):Promise<BacklinkActionState> {
  try {
    const db=await teamClient(clientId);backlinkUuid(id);
    const stage=backlinkText(form,"stage",30),due=backlinkText(form,"due_on",10);
    if(!Object.hasOwn(BACKLINK_STAGES,stage)||due&&!validDate(due)) throw new Error("Check the stage and due date.");
    const {data,error}=await db.from("backlink_opportunities").update({stage:stage as BacklinkOpportunity["stage"],due_on:due||null,next_action:backlinkText(form,"next_action"),notes:backlinkText(form,"notes",4000)})
      .eq("client_id",clientId).eq("id",id).eq("updated_at",backlinkText(form,"updated_at",50)).select("id").maybeSingle();
    if(error) throw new Error("Could not update this opportunity. Your entry is kept for retry.");
    if(!data) throw new Error("This record changed or is unavailable. Refresh before updating it.");
    refresh(clientId);return {savedId:id};
  }catch(e){return failure(e);}
}
export async function recordBacklinkCheckAction(clientId:string,id:string,_state:BacklinkActionState,form:FormData):Promise<BacklinkActionState> {
  try {
    const db=await teamClient(clientId);backlinkUuid(id);
    const {data:opportunity}=await db.from("backlink_opportunities").select("id").eq("client_id",clientId).eq("id",id).maybeSingle();
    if(!opportunity) throw new Error("Opportunity unavailable for this client.");
    const input={...parseBacklinkCheck(form),opportunity_id:id};
    const {error}=await db.from("backlink_checks").insert(input);
    if(error?.code==="23505") {
      const {data:existing}=await db.from("backlink_checks").select("*").eq("id",input.id).eq("opportunity_id",id).maybeSingle();
      if(!existing||Object.entries(input).some(([k,v])=>existing[k as keyof typeof existing]!==v)) throw new Error("This check was already saved with different data. Start a new check.");
    } else if(error) throw new Error("Could not save this check. Your entry is kept for retry.");
    refresh(clientId);return {savedId:input.id};
  }catch(e){return failure(e);}
}

export async function recordBacklinkProfileAction(clientId:string,_state:BacklinkActionState,form:FormData):Promise<BacklinkActionState> {
 try {
  const db=await teamClient(clientId);
  const [{data:client,error:ce},{data:brands,error:be}]=await Promise.all([db.from("clients").select("website_url").eq("id",clientId).maybeSingle(),db.from("client_brand_workspaces").select("website_url").eq("client_id",clientId)]);
  if(ce||be||!client)throw new Error("Client website choices are unavailable. Please retry.");
  const {parseBacklinkProfile}=await import("@/lib/backlink-profile");
  const rows=parseBacklinkProfile(clientId,form,[client.website_url,...(brands??[]).map(b=>b.website_url)].filter((v):v is string=>!!v));
  const {error}=await db.from("report_measurements").insert(rows);
  if(error?.code==="23505") {
   const {data:existing}=await db.from("report_measurements").select("*").eq("client_id",clientId).in("id",rows.map(r=>r.id));
   if(existing?.length!==rows.length||rows.some(r=>{const old=existing.find(e=>e.id===r.id);return !old||Object.entries(r).some(([k,v])=>old[k as keyof typeof old]!==v);}))throw new Error("This submission was already saved with different values. Start a new report.");
  }else if(error)throw new Error("Profile report could not be saved. Your entries are kept for retry.");
  refresh(clientId);revalidatePath(`/clients/${clientId}/growth`);revalidatePath("/portal/growth");
  return {savedId:rows[0].id};
 }catch(e){return failure(e);}
}
