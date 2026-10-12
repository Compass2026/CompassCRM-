import { test } from "node:test";
import assert from "node:assert/strict";
import { growthRange, growthSeries, deltaLabel } from "../src/lib/client-growth.ts";
import { backlinkStatus, latestBacklinkCheck, httpUrl, parseBacklinkCheck } from "../src/lib/backlinks.ts";
const row=(patch={})=>({id:"a",client_id:"client",sequence:1,metric:"forms",scope:"Site v1",source:"GA4",platform:"none",channel:"none",context:"existing_client",report_period:null,window_start:"2026-07-01",window_end:"2026-07-31",status:"measured",value:10,created_at:"2026-08-01",...patch});
test("original baseline survives backdated entries and current follows observation dates",()=>{
 const rows=[row(),row({id:"b",sequence:2,window_start:"2026-08-01",window_end:"2026-08-31",value:20}),row({id:"c",sequence:3,window_start:"2026-06-01",window_end:"2026-06-30",value:2})];
 const [s]=growthSeries(rows,growthRange({},"2026-10-12"));
 assert.equal(s.baseline.id,"a");assert.equal(s.current.id,"b");assert.equal(s.change.delta,10);
 const [filtered]=growthSeries(rows,growthRange({range:"month",month:"2026-08"},"2026-10-12"));
 assert.equal(filtered.baseline.id,"a");assert.equal(filtered.points.length,1);
});
test("unavailable results remain unavailable; source changes split series; unequal windows do not compare",()=>{
 const rows=[row({value:0}),row({id:"b",sequence:2,window_start:"2026-08-01",window_end:"2026-08-31",status:"not_connected",value:null}),row({id:"c",sequence:3,source:"Other",value:99})];
 const series=growthSeries(rows,growthRange({},"2026-10-12"));
 assert.equal(series.length,2);assert.equal(series[0].current.value,null);assert.equal(series[0].change.delta,null);
 assert.equal(growthSeries([row(),row({id:"d",sequence:2,window_start:"2026-08-01",window_end:"2026-08-10"})],growthRange({},"2026-10-12"))[0].change.delta,null);
 assert.equal(deltaLabel(5,0),"+5 since baseline");
});
test("future baseline not exposed in historical view; partial windows excluded",()=>{
 assert.equal(growthSeries([row()],growthRange({range:"month",month:"2026-06"},"2026-10-12"))[0].baseline,undefined);
 const range=growthRange({range:"custom",start:"2026-07-15",end:"2026-07-31"},"2026-10-12");
 assert.equal(growthSeries([row()],range)[0].points.length,0);
 assert.ok(growthRange({range:"custom",start:"2026-10-15",end:"2026-10-12"},"2026-10-12").error);
 assert.equal(growthRange({range:"month",month:"2026-02"},"2026-10-12").end,"2026-02-28");
});
test("lost requires previous live evidence; failed checks and stale checks are distinct",()=>{
 const check={result:"missing",observed_on:"2026-10-10"};
 assert.equal(backlinkStatus(check,false,"2026-10-12"),"Not found");
 assert.equal(backlinkStatus(check,true,"2026-10-12"),"Lost link");
 assert.equal(backlinkStatus({...check,result:"unreachable"},true,"2026-10-12"),"Could not check");
 assert.equal(backlinkStatus({...check,result:"live",observed_on:"2026-08-01"},true,"2026-10-12"),"Needs recheck");
 assert.equal(latestBacklinkCheck([{id:"b",observed_on:"2026-09-01",recorded_at:"2026-10-10"},{id:"a",observed_on:"2026-10-01",recorded_at:"2026-10-01"}]).id,"a");
});
test("outbound links reject active schemes and credentials; checks reject future evidence",()=>{
 for(const url of ["javascript:alert(1)","https://user:pass@example.com","ftp://example.com","http://localhost"]) assert.throws(()=>httpUrl(url));
 assert.equal(httpUrl("https://EXAMPLE.com/a#x"),"https://example.com/a");
 const form=new FormData(); for(const [key,value] of Object.entries({id:"00000000-0000-4000-8000-000000000001",observed_on:"2099-01-01",result:"live",rel:"follow",anchor_text:"",evidence:"Fixture"})) form.set(key,value);
 assert.throws(()=>parseBacklinkCheck(form,"2026-10-12"),/date/);
});
