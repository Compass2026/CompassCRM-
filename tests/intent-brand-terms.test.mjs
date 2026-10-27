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
  // Naming the business while evaluating it is not automatically navigational.
  assert.equal(check("logic solar reviews","commercial","Logic Solar").conflict,false);
  assert.equal(check("logic solar reviews","navigational","Logic Solar").conflict,false);
  assert.equal(check("logic solar battery backup","commercial","Logic Solar").assessed,"navigational");
});

const at=(place)=>buildPlaceIndex([place],[place],[]);
const checkAt=(query,stored,clientName,place)=>assessIntent(query,stored,{clientName,places:at(place)});

test("industry words in a business name are not brand words",()=>{
  for(const [query,intent,name] of [
    ["boxing for beginners","informational","Ridgeline Boxing"],
    ["what to wear to boxing class","informational","Ridgeline Boxing"],
    ["boxing gym near me","transactional","Ridgeline Boxing"],
    ["bathroom remodel plumbing","transactional","Ironwood Plumbing & Contracting LLC"],
    ["new construction plumbing","commercial","Ironwood Plumbing & Contracting LLC"],
    ["masonry contractor","commercial","Fieldstone Brothers Masonry"],
  ]) {
    const actual=check(query,intent,name);
    assert.notEqual(actual.assessed,"navigational",query);
    assert.equal(actual.conflict,false,query);
  }
  assert.equal(check("ridgeline boxing","navigational","Ridgeline Boxing").assessed,"navigational");
  assert.equal(check("ironwood plumbing","navigational","Ironwood Plumbing & Contracting LLC").assessed,"navigational");
});
test("a place in the business name is not a brand word",()=>{
  const name="Biloxi Equipment Rentals";
  for(const [query,intent] of [
    ["equipment rental biloxi","commercial"],
    ["equipment rental biloxi ms","transactional"],
    ["tool rental biloxi","commercial"],
    ["mini excavator rental biloxi","transactional"],
  ]) {
    const actual=checkAt(query,intent,name,"Biloxi");
    assert.notEqual(actual.assessed,"navigational",query);
    assert.equal(actual.conflict,false,query);
  }
  // The exact name is also the generic search: left to judgment either way.
  assert.equal(checkAt("biloxi equipment rentals","commercial",name,"Biloxi").assessed,"ambiguous");
  assert.equal(checkAt("biloxi equipment rentals","navigational",name,"Biloxi").conflict,false);
});
test("an equipment maker's name is not the client's brand",()=>{
  const actual=checkAt("bobcat rental biloxi","transactional","Biloxi Equipment Rentals","Biloxi");
  assert.notEqual(actual.assessed,"navigational");
  assert.equal(actual.conflict,false);
});
test("a branded query is judged by what the searcher is doing",()=>{
  const name="Ridgeline Boxing";
  // Evaluating the business: commercial or navigational, never forced.
  for(const query of ["ridgeline boxing reviews","ridgeline boxing vs title boxing club","ridgeline boxing prices"]) {
    assert.equal(check(query,"commercial",name).assessed,"ambiguous",query);
    assert.equal(check(query,"commercial",name).conflict,false,query);
  }
  // A question about the business may be informational.
  assert.equal(check("does ridgeline boxing have open gym","informational",name).conflict,false);
  // The bare name, with a place or contact words, is still a navigational search.
  assert.equal(checkAt("ridgeline boxing o'fallon","commercial",name,"O'Fallon").conflict,true);
  assert.equal(check("ridgeline boxing phone number","commercial",name).conflict,true);
});
