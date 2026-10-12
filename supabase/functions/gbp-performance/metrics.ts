export const METRICS = ["BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "CALL_CLICKS", "WEBSITE_CLICKS", "BUSINESS_DIRECTION_REQUESTS"] as const;
export function completeMonths(count = 3, now = new Date()) {
  // Leave four complete days for Google's reporting delay at month boundaries.
  const cutoff = new Date(now.getTime() - 4 * 86400000);
  const endMonth = Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), 1);
  return Array.from({length:count}, (_, i) => {
    const start = new Date(endMonth); start.setUTCMonth(start.getUTCMonth() - count + i);
    const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
    return {start:start.toISOString().slice(0,10), end:end.toISOString().slice(0,10)};
  });
}
export function normalizePerformance(raw: unknown, accountId: string, start: string, end: string) {
  const r = raw as {success?:boolean;accountId?:string;platform?:string;dateRange?:{startDate?:string;endDate?:string};metrics?:Record<string,{total?:number;values?:{date:string;value:number}[]}>};
  if (!r || r.success !== true || r.accountId !== accountId || r.platform !== "googlebusiness" || r.dateRange?.startDate !== start || r.dateRange.endDate !== end) throw new Error("response_identity_mismatch");
  const days = Math.round((Date.parse(end)-Date.parse(start))/86400000)+1;
  const totals: Record<string,number> = {};
  const daily: Record<string,{date:string;value:number}[]> = {};
  for (const metric of METRICS) {
    const m = r.metrics?.[metric];
    if (!m || !Array.isArray(m.values) || m.values.length !== days) throw new Error("incomplete_metric_days");
    const values = [...m.values].sort((a,b)=>a.date.localeCompare(b.date));
    for (let i=0;i<days;i++) {
      if (values[i].date !== new Date(Date.parse(start)+i*86400000).toISOString().slice(0,10) || !Number.isSafeInteger(values[i].value) || values[i].value<0) throw new Error("invalid_metric_day");
    }
    const total = values.reduce((sum,v)=>sum+v.value,0);
    if (!Number.isSafeInteger(total) || total !== m.total) throw new Error("metric_total_mismatch");
    totals[metric]=total; daily[metric]=values;
  }
  return {daily, values:{
    gbp_views:METRICS.slice(0,4).reduce((sum,key)=>sum+totals[key],0),
    gbp_clicks:totals.WEBSITE_CLICKS,
    gbp_call_clicks:totals.CALL_CLICKS,
    gbp_directions:totals.BUSINESS_DIRECTION_REQUESTS,
  }};
}
