export const GA4_METRICS = {sessions:"website_sessions",totalUsers:"website_users",screenPageViews:"website_pageviews"} as const;
export function websiteHost(website:string) {
 const u=new URL(website);
 if(!["https:","http:"].includes(u.protocol)||u.username||u.password||u.port)throw new Error("invalid_website");
 return u.hostname.toLowerCase().replace(/^www\./,"");
}
export function reportingPeriods(count:number,now:Date,timeZone:string,created:string) {
 const day=(d:Date)=>new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
 const cutoff=day(new Date(now.getTime()-4*86400000));
 const createdDay=day(new Date(created));
 const periods:{start:string;end:string;coverage:string}[]=[];
 const first=new Date(`${cutoff.slice(0,7)}-01T12:00:00Z`);
 for(let i=0;i<count;i++) {
  const start=new Date(first);start.setUTCMonth(start.getUTCMonth()-count+i);
  const end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);end.setUTCDate(0);
  periods[i]={start:start.toISOString().slice(0,10),end:end.toISOString().slice(0,10),coverage:"complete_month"};
 }
 periods.push({start:cutoff.slice(0,7)+"-01",end:cutoff,coverage:"month_to_date"});
 return periods.filter(p=>p.end>=createdDay).map(p=>({...p,start:p.start<createdDay?createdDay:p.start,coverage:p.start<createdDay?"partial_launch_month":p.coverage}));
}
export function normalizeGa4(raw:unknown,timeZone:string,host:string,coverage:string) {
 const r=raw as {metricHeaders?:{name:string;type:string}[];dimensionHeaders?:unknown[];rows?:{dimensionValues?:unknown[];metricValues:{value:string}[]}[];rowCount?:number;metadata?:{timeZone?:string;subjectToThresholding?:boolean;samplingMetadatas?:unknown[];dataLossFromOtherRow?:boolean}};
 if(!r?.rows?.length)throw new Error("no_reported_data");
 if(r.rows.length!==1||(r.rowCount??1)!==1||r.dimensionHeaders?.length||r.rows[0].dimensionValues?.length)throw new Error("unexpected_dimensions");
 if(r.metadata?.timeZone!==timeZone)throw new Error("timezone_mismatch");
 if(r.metadata.subjectToThresholding||r.metadata.samplingMetadatas?.length||r.metadata.dataLossFromOtherRow)throw new Error("incomplete_report");
 if(r.metricHeaders?.length!==3||r.rows[0].metricValues?.length!==3||new Set(r.metricHeaders.map(h=>h.name)).size!==3)throw new Error("invalid_metrics");
 const values:Record<string,number>={};
 r.metricHeaders.forEach((h,i)=>{const key=GA4_METRICS[h.name as keyof typeof GA4_METRICS],text=r.rows![0].metricValues[i].value;
  if(!key||h.type!=="TYPE_INTEGER"||typeof text!=="string"||!/^\d+$/.test(text)||!Number.isSafeInteger(Number(text))||Number(text)>1e12)throw new Error("invalid_metrics");
  values[key]=Number(text);
 });
 return {values,time_zone:timeZone,host,coverage};
}
