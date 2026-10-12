import { agencyToday, validDate } from "./reporting.ts";

export const BACKLINK_STAGES = { research:"Research", ready:"Ready for outreach", contacted:"Contacted", submitted:"Submitted", placed:"Placement reported", closed:"Closed" } as const;
export const BACKLINK_KINDS = { association:"Industry association", supplier:"Supplier directory", local_publication:"Local publication", partner:"Business partner", resource:"Useful resource", directory:"Relevant directory", other:"Other" } as const;
export type BacklinkOpportunity = { id:string; client_id:string; keyword_id:string; brand_workspace_id:string|null; target_url:string; source_url:string; title:string; kind:keyof typeof BACKLINK_KINDS; stage:keyof typeof BACKLINK_STAGES; next_action:string; due_on:string|null; notes:string; created_at:string; updated_at:string };
export type BacklinkCheck = { id:string; opportunity_id:string; observed_on:string; result:"live"|"missing"|"unreachable"; rel:"follow"|"nofollow"|"sponsored"|"ugc"|"unknown"; anchor_text:string; evidence:string; recorded_at:string; recorded_by:string|null };
export type PortalBacklink = { id:string; client_id:string; title:string; source_url:string; target_url:string; keyword:string; brand_name:string|null; observed_on:string; result:BacklinkCheck["result"]; rel:BacklinkCheck["rel"]; anchor_text:string; first_live_on:string|null };
export function httpUrl(value:string):string {
  let u:URL;
  try { u = new URL(value.trim()); } catch { throw new Error("Enter a complete http or https website URL."); }
  if (!["http:","https:"].includes(u.protocol) || u.username || u.password || !u.hostname.includes(".") || u.port || /[\s]/.test(value)) throw new Error("Use a public website URL without credentials or a port.");
  u.hash="";
  return u.href;
}
export function backlinkText(form:FormData,key:string,max=1000) {
  const v=form.get(key);
  if(typeof v!=="string" || v.trim().length>max) throw new Error(`Check ${key.replaceAll("_"," ")}.`);
  return v.trim();
}
export function backlinkUuid(value:string) { if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error("Invalid record identifier. Refresh and try again."); return value; }
export function parseBacklink(clientId:string, form:FormData) {
  const title=backlinkText(form,"title",200), kind=backlinkText(form,"kind",50);
  if(!title || !Object.hasOwn(BACKLINK_KINDS,kind)) throw new Error("Enter a title and opportunity type.");
  const due=backlinkText(form,"due_on",10);
  if(due && !validDate(due)) throw new Error("Choose a valid due date.");
  const brand=backlinkText(form,"brand_workspace_id",36);
  return { id:backlinkUuid(backlinkText(form,"id",36)), client_id:backlinkUuid(clientId), keyword_id:backlinkUuid(backlinkText(form,"keyword_id",36)), brand_workspace_id:brand?backlinkUuid(brand):null,
    title,kind:kind as BacklinkOpportunity["kind"],source_url:httpUrl(backlinkText(form,"source_url",2000)),target_url:httpUrl(backlinkText(form,"target_url",2000)),
    next_action:backlinkText(form,"next_action"),due_on:due||null,notes:backlinkText(form,"notes",4000) };
}
export function parseBacklinkCheck(form:FormData,today=agencyToday()) {
  const observed_on=backlinkText(form,"observed_on",10),result=backlinkText(form,"result",20),rel=backlinkText(form,"rel",20),evidence=backlinkText(form,"evidence",2000);
  if(!validDate(observed_on)||observed_on>today) throw new Error("Choose a check date ending today or earlier.");
  if(!["live","missing","unreachable"].includes(result)||!["follow","nofollow","sponsored","ugc","unknown"].includes(rel)||!evidence) throw new Error("Record the check result, link attributes, and evidence.");
  return {id:backlinkUuid(backlinkText(form,"id",36)),observed_on,result:result as BacklinkCheck["result"],rel:rel as BacklinkCheck["rel"],anchor_text:backlinkText(form,"anchor_text",500),evidence};
}
export function latestBacklinkCheck(checks:BacklinkCheck[]) {return [...checks].sort((a,b)=>b.observed_on.localeCompare(a.observed_on)||b.recorded_at.localeCompare(a.recorded_at)||b.id.localeCompare(a.id))[0];}
export function backlinkStatus(check:Pick<BacklinkCheck,"result"|"observed_on">|undefined,hadLive:boolean,today=agencyToday()) {
  if(!check) return "Not checked";
  if((Date.parse(today)-Date.parse(check.observed_on))/86400000>30) return "Needs recheck";
  if(check.result==="unreachable") return "Could not check";
  return check.result==="live"?"Verified live":hadLive?"Lost link":"Not found";
}
