// Draft with AI on the Authority tab (src/lib/authority-draft.ts): which
// state a Ready Business Profile post card shows. The linked post decides
// the lifecycle; the request is only orchestration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftControl } from "../src/lib/authority-draft.ts";

const RUN = "00000000-0000-4000-8000-000000000001";
const ready = { content_type: "gbp_post", section: "ready", action: "create", eligible_from: null };
const post = (reviewStatus, linkedAt = "2026-09-20T12:00:00Z", publishStatus = "not_scheduled") => ({ id: `p-${reviewStatus}-${linkedAt}`, reviewStatus, publishStatus, linkedAt });
const info = (over = {}) => ({ request: null, posts: [], cycleStartedAt: null, ...over });
const req = (status, notes = null) => ({ id: "t1", status, notes, createdAt: "2026-09-27T12:00:00Z" });
const today = "2026-09-27";

test("only a Ready, create Business Profile post that is not dismissed gets a control", () => {
  assert.equal(draftControl({ ...ready, content_type: "page_improvement" }, "open", info(), today, RUN), null);
  assert.equal(draftControl({ ...ready, section: "blocked" }, "open", info(), today, RUN), null);
  assert.equal(draftControl({ ...ready, action: "improve" }, "open", info(), today, RUN), null);
  assert.equal(draftControl(ready, "dismissed", info(), today, RUN), null);
  assert.deepEqual(draftControl(ready, "open", undefined, today, RUN), { state: "available", label: "Draft with AI", runId: RUN });
});

test("the linked post decides: in review, approved or published completes the cycle, rejected is draftable again", () => {
  assert.equal(draftControl(ready, "accepted", info({ posts: [post("in_review")] }), today, RUN).state, "in_review");
  assert.equal(draftControl(ready, "accepted", info({ posts: [post("approved")] }), today, RUN).state, "completed");
  assert.equal(draftControl(ready, "accepted", info({ posts: [post("approved", "2026-09-20T12:00:00Z", "published")] }), today, RUN).state, "completed");
  assert.equal(draftControl(ready, "accepted", info({ posts: [post("rejected")] }), today, RUN).state, "available");
  // A new cycle: the older approved post no longer counts.
  assert.equal(draftControl(ready, "open", info({ posts: [post("approved")], cycleStartedAt: "2026-09-25T00:00:00Z" }), today, RUN).state, "available");
});

test("a request is shown (restartable) while open; a blocked one shows the worker's last note and can be requested again", () => {
  const open = draftControl(ready, "accepted", info({ request: req("open") }), today, RUN);
  assert.deepEqual([open.state, open.taskId, open.label], ["requested", "t1", "AI draft requested"]);
  assert.equal(draftControl(ready, "accepted", info({ request: req("in_progress") }), today, RUN).label, "AI draft being written");
  const blocked = draftControl(ready, "accepted", info({ request: req("blocked", "Authority opportunity x.\ncadence_active: Not eligible until 2026-10-16.") }), today, RUN);
  assert.deepEqual([blocked.state, blocked.detail, blocked.runId], ["blocked", "cadence_active: Not eligible until 2026-10-16.", RUN]);
  // A request never outranks the post it produced.
  assert.equal(draftControl(ready, "accepted", info({ request: req("open"), posts: [post("in_review")] }), today, RUN).state, "in_review");
});

test("inside its cadence the card says when the next post is due", () => {
  const w = draftControl({ ...ready, eligible_from: "2026-10-16" }, "open", info(), today, RUN);
  assert.equal(w.state, "waiting");
  assert.match(w.detail, /2026-10-16/);
  assert.equal(draftControl({ ...ready, eligible_from: today }, "open", info(), today, RUN).state, "available");
});
