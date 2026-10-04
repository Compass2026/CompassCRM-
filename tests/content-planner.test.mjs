// The Content Planner's shared logic (src/lib/content-planner.ts): weeks on
// Compass's calendar, the weekly roll-up and what a teammate may type.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, currentWeek, mondayOf, OPPORTUNITY_DELIVERABLE, parsePlanFields, parseWeek, summarize, WEEKLY_TARGETS, weekLabel,
} from "../src/lib/content-planner.ts";

test("weeks run Monday to Sunday on Compass's (Central) calendar", () => {
  assert.equal(mondayOf("2026-10-05"), "2026-10-05");
  assert.equal(mondayOf("2026-10-11"), "2026-10-05", "Sunday belongs to the week before");
  assert.equal(mondayOf("2026-10-12"), "2026-10-12");
  assert.equal(mondayOf("2027-01-01"), "2026-12-28", "across the year end");
  assert.equal(addDays("2026-10-05", 6), "2026-10-11");
  // Sunday 11:30 pm Central is Monday 04:30 UTC: still the week of Oct 5.
  assert.equal(currentWeek(new Date("2026-10-12T04:30:00Z")), "2026-10-05");
  assert.equal(parseWeek("2026-10-08"), "2026-10-05");
  assert.equal(parseWeek("not a date", new Date("2026-10-07T15:00:00Z")), "2026-10-05");
  assert.equal(parseWeek(undefined, new Date("2026-10-07T15:00:00Z")), "2026-10-05");
  assert.equal(weekLabel("2026-10-05"), "Oct 5 – Oct 11, 2026");
});

test("the roll-up: approved + delivered against the target, the rest by status, what is left to plan", () => {
  assert.deepEqual(WEEKLY_TARGETS, { social: 2, gbp: 2, blog: 2, web_page: 1 });
  const s = summarize([
    { deliverable: "gbp", status: "approved" }, { deliverable: "gbp", status: "in_review" },
    { deliverable: "social", status: "delivered" }, { deliverable: "social", status: "delivered" }, { deliverable: "social", status: "planned" },
    { deliverable: "blog", status: "blocked" },
  ]);
  assert.deepEqual([s.gbp.done, s.gbp.planned, s.gbp.unplanned, s.gbp.byStatus], [1, 2, 0, { approved: 1, in_review: 1 }]);
  assert.deepEqual([s.social.done, s.social.unplanned], [2, 0], "a third social piece does not go negative");
  assert.deepEqual([s.blog.done, s.blog.unplanned, s.blog.byStatus.blocked], [0, 1, 1]);
  assert.deepEqual([s.web_page.done, s.web_page.planned, s.web_page.unplanned], [0, 0, 1]);
});

test("Authority content types map to slots exactly as 0064's guard does", () => {
  assert.deepEqual(OPPORTUNITY_DELIVERABLE, {
    gbp_post: "gbp", blog_post: "blog", blog_refresh: "blog", service_page: "web_page", location_page: "web_page", page_improvement: "web_page",
  });
  assert.equal(OPPORTUNITY_DELIVERABLE.data_fix, undefined);
});

test("what a teammate may type", () => {
  const week = "2026-10-05";
  const form = (o) => (k) => (k in o ? o[k] : null);
  let r = parsePlanFields(form({ deliverable: "gbp", purpose: "service", topic: " Roof replacement ", search_intent: "commercial" }), week);
  assert.ok(r.ok);
  assert.equal(r.fields.channel, "google_business");
  assert.equal(r.fields.topic, "Roof replacement");
  r = parsePlanFields(form({ deliverable: "social", purpose: "real_work", topic: "Job in O'Fallon", channel: "instagram" }), week);
  assert.ok(r.ok && r.fields.channel === "instagram" && r.fields.search_intent === null);
  r = parsePlanFields(form({ deliverable: "blog", purpose: "educational", topic: "x", channel: "facebook" }), week);
  assert.ok(r.ok && r.fields.channel === null, "a blog never carries a channel");
  const no = (o, re) => { const x = parsePlanFields(form(o), week); assert.ok(!x.ok && re.test(x.error), JSON.stringify(x)); };
  no({ deliverable: "podcast", purpose: "service", topic: "x" }, /what to plan/);
  no({ deliverable: "gbp", purpose: "viral", topic: "x" }, /purpose/);
  no({ deliverable: "gbp", purpose: "authority", topic: "x" }, /Authority opportunity/);
  no({ deliverable: "gbp", purpose: "service", topic: "  " }, /topic/);
  no({ deliverable: "social", purpose: "service", topic: "x" }, /social channel/);
  no({ deliverable: "social", purpose: "service", topic: "x", channel: "google_business" }, /social channel/);
  no({ deliverable: "gbp", purpose: "service", topic: "x", search_intent: "curious" }, /intent/);
  no({ deliverable: "gbp", purpose: "service", topic: "x", target_url: "lucas.com/roof" }, /full http/);
  no({ deliverable: "gbp", purpose: "service", topic: "x", planned_date: "2026-10-12" }, /inside this week/);
  no({ deliverable: "gbp", purpose: "service", topic: "x", service_id: "not-a-uuid" }, /Unknown service/);
});
