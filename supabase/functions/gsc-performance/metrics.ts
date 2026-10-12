export {completeMonths} from "../gbp-performance/metrics.ts";
export function normalizeGsc(raw:unknown) {
 const data=raw as {responseAggregationType?:string;rows?:{clicks?:number;impressions?:number;keys?:unknown[]}[]};
 if(data?.responseAggregationType!=="byProperty") throw new Error("aggregation_mismatch");
 if(!Array.isArray(data.rows)||!data.rows.length) throw new Error("no_reported_data");
 if(data.rows.length!==1 || (data.rows[0].keys?.length??0)!==0) throw new Error("unexpected_dimensions");
 const {clicks,impressions}=data.rows[0];
 if(!Number.isSafeInteger(clicks)||!Number.isSafeInteger(impressions)||clicks!<0||impressions!<0||clicks!>impressions!) throw new Error("invalid_metrics");
 return {aggregation:"byProperty",search_type:"web",values:{search_clicks:clicks!,search_impressions:impressions!}};
}
export function propertyMatchesWebsite(property:string,website:string) {
 try {
  const site=new URL(website);if(!["http:","https:"].includes(site.protocol))return false;
  const host=site.hostname.toLowerCase().replace(/^www\./,"");
  if(property.startsWith("sc-domain:"))return property.slice(10).toLowerCase()===host;
  const p=new URL(property);return ["http:","https:"].includes(p.protocol)&&p.hostname.toLowerCase().replace(/^www\./,"")===host&&p.pathname==="/"&&!p.username&&!p.password&&!p.search&&!p.hash;
 } catch {return false;}
}
