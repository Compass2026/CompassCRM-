import { test } from "node:test";
import assert from "node:assert/strict";
import { assessIntent } from "../supabase/functions/authority/intent.ts";
import { buildPlaceIndex } from "../supabase/functions/authority/urls.ts";

const places=buildPlaceIndex([],[],[]);
const check=(query,stored,clientName)=>assessIntent(query,stored,{clientName,places});

test("generic forklift and equipment keywords are not BHG navigational queries",()=>{
  for(const [query,intent,name] of [
    ["forklift training course","informational","BHG Forklift Training"],
    ["heavy equipment operator training","commercial","BHG Heavy Equipment Training"],
    ["forklift operator evaluation checklist","informational","BHG Forklift Training"],
    ["safety consultant","commercial","BHG Safety Partners LLC"],
  ]) {
    const actual=check(query,intent,name);
    assert.notEqual(actual.assessed,"navigational",query);
    assert.equal(actual.conflict,false,query);
  }
});
test("distinctive names and exact business initials still signal branded searches",()=>{
  assert.equal(check("BHG","navigational","BHG Forklift Training").assessed,"navigational");
  assert.equal(check("BHG forklift training","commercial","BHG Forklift Training").conflict,true);
  assert.equal(check("Lucas Construction","navigational","Lucas Construction").assessed,"navigational");
  assert.equal(check("Ginger Huff Interiors","navigational","Ginger Huff Interiors").assessed,"navigational");
  assert.equal(check("Ginger design","commercial","Ginger Huff Interiors").conflict,true);
});
test("solar is an industry noun, not Logic Solar's brand",()=>{
  for(const [query,intent] of [
    ["solar battery backup overland park ks","commercial"],
    ["solar battery backup wichita ks","commercial"],
    ["solar site assessment kansas","commercial"],
    ["commercial solar wichita ks","commercial"],
    ["solar system monitoring","informational"],
    ["solar installation overland park ks","transactional"],
  ]) {
    const actual=check(query,intent,"Logic Solar");
    assert.notEqual(actual.assessed,"navigational",query);
    assert.equal(actual.conflict,false,query);
  }
  // The distinctive word still marks a branded search.
  assert.equal(check("logic solar","navigational","Logic Solar").assessed,"navigational");
  assert.equal(check("logic solar reviews","commercial","Logic Solar").assessed,"navigational");
  assert.equal(check("logic solar battery backup","commercial","Logic Solar").assessed,"navigational");
});
