import { test } from "node:test";
import assert from "node:assert/strict";
import { claimCategories } from "../supabase/functions/post-drafter/rules.ts";

test("OSHA CFR references are not misclassified as a client's founding year",()=>{
 for (const claim of [
  "Under OSHA 29 CFR 1910.178(l), employers train and evaluate powered industrial truck operators.",
  "OSHA 29 CFR 1926.20(b)(4) addresses operating equipment by qualified workers.",
  "29 CFR 1926.21(b)(2) requires training about hazardous site conditions.",
  "Workplace forklift requirements are found in 1910.178(l)(4).",
 ]) {
  assert.ok(!claimCategories(claim).includes("tenure"),claim);
 }
});
test("actual founding year or business tenure is still protected",()=>{
 assert.ok(claimCategories("Our company was founded in 2014.").includes("tenure"));
 assert.ok(claimCategories("The company was founded in 2014 and uses OSHA 29 CFR 1910.178.").includes("tenure"));
 assert.ok(claimCategories("Over 20 years of safety experience.").includes("tenure"));
});
